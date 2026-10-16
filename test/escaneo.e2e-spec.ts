import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { EntregaWebhooks } from '../src/modules/entrega/entrega-webhooks';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearApp } from './utils/crear-app';
import { Datos, sobre } from './utils/datos';
import { IdentidadFalsa } from './utils/identidad-falsa';
import { LimitesReiniciables } from './utils/limites';
import { Receptor } from './utils/receptor';
import { RelojDePrueba } from './utils/reloj';

/**
 * Un recorrido completo (suscripciones, errores, publicación, entregas buenas y fallidas, bajas)
 * con el HTTP real, y después el escaneo: ni los logs, ni la auditoría, ni las respuestas tienen
 * un secreto (en claro o cifrado), una firma, un token o la URL completa de un webhook.
 *
 * La excepción son las respuestas de las propias suscripciones (POST 201 y GET 200), que el
 * contrato obliga a devolver con su `url` al mismo dueño (WebhookSubscription.url): esas se
 * revisan aparte (solo el secreto enmascarado).
 */
describe('Escaneo: nada sensible en logs, auditoría ni respuestas', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  const logs: string[] = [];
  const respuestas: Array<{ ruta: string; status: number; texto: string; deSuscripcion: boolean }> =
    [];
  let identidad: IdentidadFalsa;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let datos: Datos;
  let receptor: Receptor;

  const RUTA = `/escaneo/${randomUUID()}`;
  const TOKEN_URL = `token-url-${randomUUID()}`;
  const SECRETOS = [`secreto-escaneo-uno-${randomUUID()}`, `secreto-escaneo-dos-${randomUUID()}`];
  const PNR = 'S3CR3T';
  const tokens: string[] = [];
  const suscripciones: string[] = [];
  let urlCompleta: string;

  const guardar = (r: request.Response, ruta: string, deSuscripcion = false) => {
    respuestas.push({
      ruta,
      status: r.status,
      texto: `${JSON.stringify(r.headers)}\n${r.text}`,
      deSuscripcion,
    });
    return r;
  };

  beforeAll(async () => {
    identidad = await IdentidadFalsa.iniciar(() => reloj.ahora());
    app = await crearApp({ identidad, reloj, limites, logs });
    prisma = app.get(PrismaService);
    datos = new Datos(app, identidad);
    receptor = new Receptor();
    await receptor.iniciar();
    urlCompleta = receptor.url(`${RUTA}?token=${TOKEN_URL}`);

    const dueno = datos.dueno();
    const token = datos.tokenDe(dueno);
    const publicador = identidad.firmarPublicador();
    tokens.push(token, publicador);
    const http = () => request(app.getHttpServer());
    const conToken = (r: request.Test, t = token) => r.set('Authorization', `Bearer ${t}`);

    // Altas: dos buenas, una repetida (409) y varias inválidas con el secreto y la URL adentro
    for (const [i, secreto] of SECRETOS.entries()) {
      const url = i === 0 ? urlCompleta : receptor.url(`${RUTA}/dos?token=${TOKEN_URL}`);
      const r = guardar(
        await conToken(http().post('/flights/v1/webhooks')).send({
          url,
          events: ['booking.confirmed', 'booking.cancelled'],
          secret: secreto,
        }),
        'POST /webhooks',
        true,
      );
      suscripciones.push((r.body as { id: string }).id);
    }
    guardar(
      await conToken(http().post('/flights/v1/webhooks')).send({
        url: urlCompleta,
        events: ['booking.confirmed'],
        secret: SECRETOS[0],
      }),
      'POST /webhooks repetida',
    );
    for (const cuerpo of [
      { url: urlCompleta, events: [], secret: SECRETOS[0] },
      { url: urlCompleta, events: ['booking.confirmed'], secret: `${SECRETOS[0]} con espacios` },
      {
        url: `http://169.254.169.254${RUTA}?token=${TOKEN_URL}`,
        events: ['booking.confirmed'],
        secret: SECRETOS[0],
      },
      {
        url: `ftp://localhost${RUTA}?token=${TOKEN_URL}`,
        events: ['booking.confirmed'],
        secret: SECRETOS[0],
      },
    ]) {
      guardar(
        await conToken(http().post('/flights/v1/webhooks')).send(cuerpo),
        'POST /webhooks inválida',
      );
    }
    guardar(await conToken(http().get('/flights/v1/webhooks')), 'GET /webhooks', true);

    // Publicación: buena, repetida, en conflicto, inválida y desconocida
    const evento = sobre('booking.confirmed', dueno);
    (evento.data as Record<string, unknown>).pnr = PNR;
    guardar(await datos.publicar(evento, publicador), 'POST /events');
    guardar(await datos.publicar(evento, publicador), 'POST /events repetido');
    guardar(
      await datos.publicar(
        { ...evento, data: { ...(evento.data as object), status: 'FAILED' } },
        publicador,
      ),
      'POST /events conflicto',
    );
    const invalido = sobre('booking.cancelled', dueno);
    (invalido.data as Record<string, unknown>).pnr = `${PNR}-${SECRETOS[0]}`;
    guardar(await datos.publicar(invalido, publicador), 'POST /events inválido');
    guardar(
      await datos.publicar(
        sobre('booking.confirmed', dueno, { eventType: SECRETOS[1] }),
        publicador,
      ),
      'POST /events desconocido',
    );
    guardar(await datos.publicar(evento, token), 'POST /events con token de persona');
    const cancelado = sobre('booking.cancelled', dueno);
    (cancelado.data as Record<string, unknown>).pnr = PNR;
    guardar(await datos.publicar(cancelado, publicador), 'POST /events cancelado');

    // Entregas con el HTTP real: primero el receptor falla, después responde
    const entrega = app.get(EntregaWebhooks);
    receptor.codigo = 500;
    await entrega.ejecutar();
    receptor.codigo = 200;
    reloj.adelantar(1);
    await entrega.ejecutar();

    // Bajas: una ajena (404) y las propias
    guardar(
      await conToken(
        http().delete(`/flights/v1/webhooks/${suscripciones[0]}`),
        datos.tokenDe(randomUUID()),
      ),
      'DELETE ajena',
    );
    for (const id of suscripciones) {
      guardar(await conToken(http().delete(`/flights/v1/webhooks/${id}`)), 'DELETE');
    }
  }, 60_000);

  afterAll(async () => {
    await datos.darDeBaja();
    await receptor.detener();
    await app.close();
    await identidad.detener();
  });

  /** Todo lo que no puede aparecer en ningún lado (salvo donde el contrato lo pide). */
  const prohibidos = async (): Promise<string[]> => {
    const cifrados = await prisma.db.suscripcion.findMany({
      where: { id: { in: suscripciones } },
      select: { secreto_cifrado: true },
    });
    const firmas = receptor.recibidos
      .map((r) => r.cabeceras['x-webhook-signature'])
      .filter((f): f is string => typeof f === 'string');
    return [
      ...SECRETOS,
      ...cifrados.map((c) => c.secreto_cifrado),
      ...firmas,
      ...firmas.map((f) => f.slice('sha256='.length)),
      ...tokens,
      ...tokens.map((t) => t.split('.')[2]),
      TOKEN_URL,
      RUTA,
    ];
  };

  it('el recorrido de verdad pasó por todo (si no, el escaneo no probaría nada)', async () => {
    expect(suscripciones).toHaveLength(2);
    expect(receptor.recibidos.filter((r) => r.ruta.startsWith(RUTA)).length).toBeGreaterThanOrEqual(
      2,
    );
    expect(receptor.recibidos.some((r) => r.cuerpo.includes(PNR))).toBe(true);
    expect(respuestas.map((r) => r.status)).toEqual(
      expect.arrayContaining([201, 409, 400, 200, 202, 422, 403, 404, 204]),
    );
    expect(logs.some((l) => l.includes('intento 1/5: PENDIENTE 500'))).toBe(true);
    expect(logs.some((l) => l.includes('ENTREGADO 200'))).toBe(true);
    expect(
      await prisma.db.auditoria.count({ where: { suscripcion_id: { in: suscripciones } } }),
    ).toBe(4);
  });

  it('los logs no tienen secretos, firmas, tokens, la URL de un webhook ni el cuerpo de un evento', async () => {
    const texto = logs.join('\n');
    for (const prohibido of [
      ...(await prohibidos()),
      PNR,
      '127.0.0.1:' + new URL(urlCompleta).port,
    ]) {
      expect(texto).not.toContain(prohibido);
    }
  });

  it('la auditoría no tiene secretos (ni cifrados) ni la URL: solo el host', async () => {
    const filas = await prisma.db.$queryRaw<Array<{ fila: string }>>`
      SELECT row_to_json(a)::text AS fila FROM notificaciones.auditoria a
       WHERE a.suscripcion_id = ANY(${suscripciones}::uuid[])`;
    expect(filas).toHaveLength(4);
    const texto = filas.map((f) => f.fila).join('\n');
    for (const prohibido of await prohibidos()) expect(texto).not.toContain(prohibido);
    expect(texto).toContain(`"host_destino":"127.0.0.1:${new URL(urlCompleta).port}"`);
  });

  it('ninguna respuesta tiene un secreto, una firma o un token; solo las de la propia suscripción traen su URL', async () => {
    const lista = await prohibidos();
    for (const respuesta of respuestas) {
      for (const prohibido of lista) {
        if (respuesta.deSuscripcion && (prohibido === TOKEN_URL || prohibido === RUTA)) continue;
        expect({ ruta: respuesta.ruta, contiene: respuesta.texto.includes(prohibido) }).toEqual({
          ruta: respuesta.ruta,
          contiene: false,
        });
      }
    }
    // Las de la suscripción: el secreto, enmascarado
    for (const respuesta of respuestas.filter((r) => r.deSuscripcion)) {
      expect(respuesta.texto).toMatch(/"secret":"\*\*\*\*/);
    }
  });
});
