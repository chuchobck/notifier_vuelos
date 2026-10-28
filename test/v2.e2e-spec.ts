import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { EVENTOS, TipoEvento } from '../src/modules/compartido/eventos-webhook';
import {
  ClienteWebhook,
  PeticionWebhook,
  ResultadoWebhook,
} from '../src/modules/entrega/cliente-webhook';
import { ClienteWebhookHttp } from '../src/modules/entrega/cliente-webhook-http';
import { EntregaWebhooks } from '../src/modules/entrega/entrega-webhooks';
import { PrismaService } from '../src/prisma/prisma.service';
import { esperarCloudEventV2, esperarEsquemaV2 } from './utils/contrato-v2';
import { crearApp } from './utils/crear-app';
import { Datos, ejemplo, sobre } from './utils/datos';
import { IdentidadFalsa } from './utils/identidad-falsa';
import { LimitesReiniciables } from './utils/limites';
import { Receptor } from './utils/receptor';
import { RelojDePrueba } from './utils/reloj';

/** Reenvía al receptor real (ClienteWebhookHttp) o simula un fallo, según la prueba. */
class ClienteControlable extends ClienteWebhook {
  llamadas: PeticionWebhook[] = [];
  modo: ((p: PeticionWebhook) => Promise<ResultadoWebhook>) | null = null;
  constructor(private readonly real: () => ClienteWebhookHttp) {
    super();
  }
  enviar(peticion: PeticionWebhook): Promise<ResultadoWebhook> {
    this.llamadas.push(peticion);
    return this.modo ? this.modo(peticion) : this.real().enviar(peticion);
  }
}

/**
 * La firma de una entrega v2 calculada aquí, sin el código del servicio: HMAC-SHA256 del cuerpo
 * tal cual llegó, con el secreto, en hexadecimal y con el prefijo sha256= (el contrato v2:
 * `sha256=<HMAC-SHA256(secret, body)>`). Es lo que hace Booking para verificar.
 */
const firmaV2 = (secreto: string, cuerpo: string) =>
  `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}`;
const firmaV1 = (secreto: string, ts: string, cuerpo: string) =>
  `sha256=${createHmac('sha256', secreto).update(`${ts}.${cuerpo}`).digest('hex')}`;

/** El ejemplo más completo de un tipo: el de 1.1 si el esquema lo tiene. */
function ejemploCompleto(tipo: TipoEvento): Record<string, unknown> {
  try {
    return ejemplo(tipo, 1) ?? ejemplo(tipo);
  } catch {
    return ejemplo(tipo);
  }
}

describe('Contrato de Vuelos v2 (webhooks CloudEvents y feed)', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  let real: ClienteWebhookHttp;
  const cliente = new ClienteControlable(() => real);
  let identidad: IdentidadFalsa;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let entrega: EntregaWebhooks;
  let receptor: Receptor;
  let datos: Datos;
  const logs: string[] = [];

  const http = () => request(app.getHttpServer());
  const token = (dueno: string, scope = 'flights:webhooks') => datos.tokenDe(dueno, scope);
  const vaciar = async () => {
    for (let i = 0; i < 50; i++) {
      const r = await entrega.ejecutar();
      if (r.entregadas + r.reintentos + r.fallidas === 0) return;
    }
  };

  beforeAll(async () => {
    identidad = await IdentidadFalsa.iniciar(() => reloj.ahora());
    app = await crearApp({ identidad, reloj, limites, clienteWebhook: cliente, logs });
    prisma = app.get(PrismaService);
    entrega = app.get(EntregaWebhooks);
    real = new ClienteWebhookHttp(app.get(ConfigService));
    receptor = new Receptor();
    await receptor.iniciar();
    datos = new Datos(app, identidad);
    await vaciar();
  });

  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
    cliente.llamadas = [];
    cliente.modo = null;
    receptor.recibidos = [];
    receptor.codigo = 200;
    logs.length = 0;
  });

  afterAll(async () => {
    await datos.darDeBaja();
    reloj.adelantar(60 * 24 * 2);
    await vaciar();
    await receptor.detener();
    await app.close();
    await identidad.detener();
  });

  describe('/api/v2/vuelos/webhooks', () => {
    it('POST 201 con la WebhookSubscription del contrato v2 (sin el secreto, active, createdAt)', async () => {
      const dueno = datos.dueno();
      const respuesta = await http()
        .post('/api/v2/vuelos/webhooks')
        .set('Authorization', `Bearer ${token(dueno)}`)
        .set('X-Correlation-Id', 'corr-alta-v2')
        .send({
          url: receptor.url('/v2/alta'),
          events: ['flight.status_changed', 'hold.created', 'booking.confirmed'],
          secret: 'un-secreto-compartido-largo',
        })
        .expect(201);
      esperarEsquemaV2('WebhookSubscription', respuesta.body);
      expect(respuesta.headers['x-correlation-id']).toBe('corr-alta-v2');
      expect(respuesta.body).toMatchObject({
        url: receptor.url('/v2/alta'),
        // En el orden de VuelosEventName, no en el pedido
        events: ['hold.created', 'booking.confirmed', 'flight.status_changed'],
        active: true,
      });
      // secret es writeOnly en el contrato v2: no vuelve, ni enmascarado
      expect(respuesta.body.secret).toBeUndefined();
      expect(JSON.stringify(respuesta.body)).not.toContain('un-secreto-compartido-largo');
      expect(Date.parse(respuesta.body.createdAt)).not.toBeNaN();
    });

    it('cada API ve solo las suyas: GET v2 no lista una v1 ni GET v1 una v2, y DELETE cruzado es 404', async () => {
      const dueno = datos.dueno();
      const v1 = await datos.suscribir(dueno, receptor.url('/v1/a'), ['booking.confirmed']);
      const v2 = await datos.suscribirV2(dueno, receptor.url('/v2/a'), ['hold.created']);
      const listaV2 = await http()
        .get('/api/v2/vuelos/webhooks')
        .set('Authorization', `Bearer ${token(dueno)}`)
        .expect(200);
      expect(listaV2.body.map((s: { id: string }) => s.id)).toEqual([v2.id]);
      for (const s of listaV2.body) esperarEsquemaV2('WebhookSubscription', s);
      const listaV1 = await http()
        .get('/flights/v1/webhooks')
        .set('Authorization', `Bearer ${token(dueno)}`)
        .expect(200);
      expect(listaV1.body.map((s: { id: string }) => s.id)).toEqual([v1.id]);

      const cruzado = await http()
        .delete(`/api/v2/vuelos/webhooks/${v1.id}`)
        .set('Authorization', `Bearer ${token(dueno)}`)
        .set('X-Correlation-Id', 'corr-borrar-cruzado')
        .expect(404);
      esperarEsquemaV2('ProblemDetails', cruzado.body);
      expect(cruzado.body).toMatchObject({
        code: 'NOT_FOUND',
        instance: `/api/v2/vuelos/webhooks/${v1.id}`,
        correlation_id: 'corr-borrar-cruzado',
      });
      await http()
        .delete(`/flights/v1/webhooks/${v2.id}`)
        .set('Authorization', `Bearer ${token(dueno)}`)
        .expect(404);
      await http()
        .delete(`/api/v2/vuelos/webhooks/${v2.id}`)
        .set('Authorization', `Bearer ${token(dueno)}`)
        .expect(204);
    });

    it('los 3 tipos de v2 se aceptan en v2 y no en v1 (400); un tipo inventado, 400 en los dos', async () => {
      const dueno = datos.dueno();
      const nuevos = ['hold.created', 'booking.seat_changed', 'flight.status_changed'];
      await datos.suscribirV2(dueno, receptor.url('/v2/nuevos'), nuevos as TipoEvento[]);
      const v1 = await http()
        .post('/flights/v1/webhooks')
        .set('Authorization', `Bearer ${token(dueno)}`)
        .send({ url: receptor.url('/v1/nuevos'), events: nuevos, secret: 'secreto-de-prueba-123' })
        .expect(400);
      expect(v1.body.instance).toBeUndefined(); // v1 sigue con su ProblemDetails
      const v2 = await http()
        .post('/api/v2/vuelos/webhooks')
        .set('Authorization', `Bearer ${token(dueno)}`)
        .send({
          url: receptor.url('/v2/x'),
          events: ['payment.captured'],
          secret: 'secreto-de-prueba-123',
        })
        .expect(400);
      esperarEsquemaV2('ProblemDetails', v2.body);
      expect(v2.body.code).toBe('VALIDATION_FAILED');
    });

    it('mismas reglas que v1: URL repetida (también entre v1 y v2) 409, máximo de 10 sumando las dos, SSRF 400', async () => {
      const dueno = datos.dueno();
      const url = receptor.url('/repetida');
      await datos.suscribir(dueno, url, ['booking.confirmed']);
      const repetida = await http()
        .post('/api/v2/vuelos/webhooks')
        .set('Authorization', `Bearer ${token(dueno)}`)
        .send({ url, events: ['booking.confirmed'], secret: 'secreto-de-prueba-123' })
        .expect(409);
      esperarEsquemaV2('ProblemDetails', repetida.body);
      expect(JSON.stringify(repetida.body)).not.toContain(url);
      for (let i = 1; i < 10; i++) {
        await datos.suscribirV2(dueno, receptor.url(`/max/${i}`), ['booking.confirmed']);
      }
      limites.reiniciar();
      await http()
        .post('/api/v2/vuelos/webhooks')
        .set('Authorization', `Bearer ${token(dueno)}`)
        .send({
          url: receptor.url('/max/11'),
          events: ['hold.created'],
          secret: 'secreto-de-prueba-123',
        })
        .expect(409);
      const ssrf = await http()
        .post('/api/v2/vuelos/webhooks')
        .set('Authorization', `Bearer ${token(datos.dueno())}`)
        .send({
          url: 'http://169.254.169.254/latest',
          events: ['hold.created'],
          secret: 'secreto-de-prueba-123',
        })
        .expect(400);
      esperarEsquemaV2('ProblemDetails', ssrf.body);
    });

    it('401 y 403 con el ProblemDetails v2 (UNAUTHORIZED, FORBIDDEN) y el correlation_id de la petición', async () => {
      const sin = await http()
        .get('/api/v2/vuelos/webhooks')
        .set('X-Correlation-Id', 'corr-sin-token')
        .expect(401);
      esperarEsquemaV2('ProblemDetails', sin.body);
      expect(sin.body).toMatchObject({ code: 'UNAUTHORIZED', correlation_id: 'corr-sin-token' });
      const scope = await http()
        .get('/api/v2/vuelos/webhooks')
        .set('Authorization', `Bearer ${token(datos.dueno(), 'flights:read')}`)
        .expect(403);
      esperarEsquemaV2('ProblemDetails', scope.body);
      expect(scope.body.code).toBe('FORBIDDEN');
      // Un X-Correlation-Id inválido no rompe la petición: se genera otro
      const invalido = await http()
        .get('/api/v2/vuelos/webhooks')
        .set('X-Correlation-Id', 'con espacios y ñ')
        .expect(401);
      expect(invalido.body.correlation_id).toMatch(/^corr-[0-9a-f-]{36}$/);
      expect(invalido.headers['x-correlation-id']).toBe(invalido.body.correlation_id);
    });
  });

  describe('entrega CloudEvents a una suscripción v2', () => {
    it.each([...EVENTOS])(
      '%s: cumple el contrato v2, firma verificable y sin traceparent',
      async (tipo) => {
        const dueno = datos.dueno();
        const ruta = `/ce/${randomUUID()}`;
        const { secreto } = await datos.suscribirV2(dueno, receptor.url(ruta), [tipo]);
        const evento = sobre(tipo, dueno, {
          ...ejemploCompleto(tipo),
          eventId: randomUUID(),
          ownerId: dueno,
        });
        await datos.publicar(evento).expect(202);
        await vaciar();
        const [recibido] = receptor.de(ruta);
        expect(recibido).toBeDefined();
        const cuerpo = JSON.parse(recibido.cuerpo) as Record<string, unknown>;
        esperarCloudEventV2(tipo, cuerpo);
        expect(cuerpo).toMatchObject({
          specversion: '1.0',
          type: `ec.edu.epn.booking.vuelos.${tipo}`,
          source: '/aerolineas/quinde/vuelos',
          id: evento.eventId,
          time: new Date(evento.occurredAt as string).toISOString(),
          datacontenttype: 'application/json',
          data: evento.data,
        });
        const data = evento.data as Record<string, string>;
        expect(cuerpo.subject).toBe(
          tipo.startsWith('hold.')
            ? data.holdId
            : tipo === 'flight.status_changed'
              ? `${data.flightNumber}/${data.date}`
              : data.bookingId,
        );
        expect(recibido.cabeceras['content-type']).toBe('application/cloudevents+json');
        expect(recibido.cabeceras['x-webhook-signature']).toBe(firmaV2(secreto, recibido.cuerpo));
        expect(recibido.cabeceras['x-correlation-id']).toBe(cuerpo.correlationid);
        expect(recibido.cabeceras.traceparent).toBeUndefined();
        expect(recibido.cabeceras.tracestate).toBeUndefined();
      },
    );

    it('con otro secreto la firma no coincide (control de la verificación independiente)', async () => {
      const dueno = datos.dueno();
      const ruta = `/ce/${randomUUID()}`;
      await datos.suscribirV2(dueno, receptor.url(ruta), ['booking.confirmed']);
      await datos.publicar(sobre('booking.confirmed', dueno)).expect(202);
      await vaciar();
      const [recibido] = receptor.de(ruta);
      expect(recibido.cabeceras['x-webhook-signature']).not.toBe(
        firmaV2('otro-secreto-cualquiera', recibido.cuerpo),
      );
    });

    it('reintentos del contrato v2: 1, 5, 30, 120 y 360 min y FALLIDO al sexto (v1 sigue en 5)', async () => {
      const dueno = datos.dueno();
      const urlV2 = receptor.url(`/r2/${randomUUID()}`);
      const urlV1 = receptor.url(`/r1/${randomUUID()}`);
      const v2 = await datos.suscribirV2(dueno, urlV2, ['booking.confirmed']);
      const v1 = await datos.suscribir(dueno, urlV1, ['booking.confirmed']);
      await datos.publicar(sobre('booking.confirmed', dueno)).expect(202);
      cliente.modo = () => Promise.resolve({ codigoHttp: 500, error: null });
      const esperas = [1, 5, 30, 120, 360];
      for (let intento = 1; intento <= 6; intento++) {
        const inicio = reloj.ahora();
        await entrega.ejecutar();
        const [fila] = await prisma.db.entrega.findMany({ where: { suscripcion_id: v2.id } });
        expect(fila.intentos).toBe(intento);
        if (intento < 6) {
          expect(fila.estado).toBe('PENDIENTE');
          expect(fila.proximo_intento.getTime()).toBe(
            inicio.getTime() + esperas[intento - 1] * 60_000,
          );
          reloj.adelantar(esperas[intento - 1]);
        } else {
          expect(fila.estado).toBe('FALLIDO');
        }
      }
      const [filaV1] = await prisma.db.entrega.findMany({ where: { suscripcion_id: v1.id } });
      expect(filaV1).toMatchObject({ estado: 'FALLIDO', intentos: 5 });
      expect(cliente.llamadas.filter((l) => l.url === urlV2)).toHaveLength(6);
    });
  });

  describe('una suscripción v1 sigue recibiendo lo mismo de antes', () => {
    it('byte a byte: el WebhookPayload v1 (orden de jsonb), sin nada de v2, con la firma de "timestamp.cuerpo"', async () => {
      const dueno = datos.dueno();
      const rutaV1 = `/v1/${randomUUID()}`;
      const rutaV2 = `/v2/${randomUUID()}`;
      const { secreto } = await datos.suscribir(dueno, receptor.url(rutaV1), ['booking.confirmed']);
      await datos.suscribirV2(dueno, receptor.url(rutaV2), ['booking.confirmed']);
      const eventId = randomUUID();
      const bookingId = '3f0c6a9e-2b1d-4c8e-9a7f-5d4e3c2b1a09';
      await datos
        .publicar({
          eventId,
          eventType: 'booking.confirmed',
          schemaVersion: '1.1',
          occurredAt: '2026-10-16T14:30:00Z',
          ownerId: dueno,
          correlationId: 'corr-no-va-en-v1',
          data: { bookingId, pnr: 'Q7K2MX', status: 'CONFIRMED' },
        })
        .expect(202);
      await vaciar();
      const [v1] = receptor.de(rutaV1);
      // Lo mismo que entregaba la fase 5a (y el core): el orden de claves es el de jsonb
      expect(v1.cuerpo).toBe(
        `{"data":{"pnr":"Q7K2MX","status":"CONFIRMED","bookingId":"${bookingId}"},` +
          `"eventId":"${eventId}","eventType":"booking.confirmed","apiVersion":"1.5.0",` +
          `"occurredAt":"2026-10-16T14:30:00.000Z"}`,
      );
      expect(v1.cabeceras['content-type']).toBe('application/json');
      expect(v1.cabeceras['x-webhook-event']).toBe('booking.confirmed');
      expect(v1.cabeceras['x-webhook-id']).toBe(eventId);
      const ts = v1.cabeceras['x-webhook-timestamp'] as string;
      expect(v1.cabeceras['x-webhook-signature']).toBe(firmaV1(secreto, ts, v1.cuerpo));
      // Lo único nuevo en v1 es la cabecera de correlación (fuera del cuerpo y de la firma)
      expect(v1.cabeceras['x-correlation-id']).toBe('corr-no-va-en-v1');
      expect(v1.cabeceras.traceparent).toBeUndefined();
      // Y la v2 del mismo dueño recibió el CloudEvent del mismo hecho
      const [v2] = receptor.de(rutaV2);
      expect(JSON.parse(v2.cuerpo)).toMatchObject({
        id: eventId,
        correlationid: 'corr-no-va-en-v1',
      });
    });
  });

  describe('correlación: del sobre al CloudEvent, a la cabecera de la entrega y al log', () => {
    const publicarYEntregar = async (cambios: Record<string, unknown>, cabecera?: string) => {
      const dueno = datos.dueno();
      const ruta = `/corr/${randomUUID()}`;
      await datos.suscribirV2(dueno, receptor.url(ruta), ['booking.cancelled']);
      const evento = sobre('booking.cancelled', dueno, cambios);
      const peticion = datos.publicar(evento);
      if (cabecera) peticion.set('X-Correlation-Id', cabecera);
      await peticion.expect(202);
      await vaciar();
      const [recibido] = receptor.de(ruta);
      return { recibido, cuerpo: JSON.parse(recibido.cuerpo) as Record<string, unknown>, evento };
    };

    it('el correlationId del sobre gana (aunque la publicación traiga otro) y llega igual a todo', async () => {
      const { recibido, cuerpo, evento } = await publicarYEntregar(
        { correlationId: 'corr-del-sobre-1', schemaVersion: '1.1' },
        'corr-de-la-cabecera',
      );
      expect(cuerpo.correlationid).toBe('corr-del-sobre-1');
      expect(recibido.cabeceras['x-correlation-id']).toBe('corr-del-sobre-1');
      const fila = await prisma.db.evento.findUnique({
        where: { id_evento: evento.eventId as string },
      });
      expect(fila?.correlation_id).toBe('corr-del-sobre-1');
      const lineas = logs.map((l) => JSON.parse(l) as Record<string, unknown>);
      const intento = lineas.find(
        (l) =>
          l.context === 'EntregaWebhooks' && String(l.message).includes('booking.cancelled v2'),
      );
      expect(intento?.correlationId).toBe('corr-del-sobre-1');
    });

    it('sin correlationId en el sobre (el core de hoy), el X-Correlation-Id de la publicación', async () => {
      const { recibido, cuerpo } = await publicarYEntregar({}, 'corr-del-relevo-7');
      expect(cuerpo.correlationid).toBe('corr-del-relevo-7');
      expect(recibido.cabeceras['x-correlation-id']).toBe('corr-del-relevo-7');
    });

    it('sin ninguno de los dos (un proceso periódico del core), uno generado corr-<uuid>, el mismo en todo', async () => {
      const { recibido, cuerpo } = await publicarYEntregar({});
      expect(cuerpo.correlationid).toMatch(/^corr-[0-9a-f-]{36}$/);
      expect(recibido.cabeceras['x-correlation-id']).toBe(cuerpo.correlationid);
    });
  });

  describe('GET /api/v2/vuelos/eventos (feed)', () => {
    const leer = (
      dueno: string,
      query: Record<string, string | number> = {},
      scope = 'flights:read',
    ) =>
      http()
        .get('/api/v2/vuelos/eventos')
        .query(query)
        .set('Authorization', `Bearer ${token(dueno, scope)}`);

    it('paginación por cursor: limit, after y next_after, en orden de llegada, como VuelosEventosResponse', async () => {
      const dueno = datos.dueno();
      const ids: string[] = [];
      for (const tipo of [
        'hold.created',
        'booking.confirmed',
        'booking.ticket_issued',
        'flight.status_changed',
        'booking.cancelled',
      ] as TipoEvento[]) {
        const evento = sobre(tipo, dueno);
        await datos.publicar(evento).expect(202);
        ids.push(evento.eventId as string);
      }
      const primera = await leer(dueno, { limit: 2 }).expect(200);
      esperarEsquemaV2('VuelosEventosResponse', primera.body);
      expect(primera.body.events.map((e: { id: string }) => e.id)).toEqual(ids.slice(0, 2));
      expect(primera.body.metadata).toMatchObject({ total: 2, next_after: ids[1] });
      for (const e of primera.body.events) {
        esperarCloudEventV2(e.type.replace('ec.edu.epn.booking.vuelos.', '') as TipoEvento, e);
      }
      const segunda = await leer(dueno, {
        limit: 2,
        after: primera.body.metadata.next_after,
      }).expect(200);
      expect(segunda.body.events.map((e: { id: string }) => e.id)).toEqual(ids.slice(2, 4));
      const ultima = await leer(dueno, {
        limit: 2,
        after: segunda.body.metadata.next_after,
      }).expect(200);
      expect(ultima.body.events.map((e: { id: string }) => e.id)).toEqual([ids[4]]);
      const vacia = await leer(dueno, { after: ids[4] }).expect(200);
      expect(vacia.body).toMatchObject({ events: [], metadata: { total: 0, next_after: null } });
      // Sin limit: 20 por defecto (aquí, los 5)
      expect((await leer(dueno).expect(200)).body.events).toHaveLength(5);
      // Filtro por tipo
      const soloReservas = await leer(dueno, { type: 'booking.confirmed' }).expect(200);
      expect(soloReservas.body.events.map((e: { id: string }) => e.id)).toEqual([ids[1]]);
    });

    it('el CloudEvent del feed es el mismo que llegó por webhook', async () => {
      const dueno = datos.dueno();
      const ruta = `/feed/${randomUUID()}`;
      await datos.suscribirV2(dueno, receptor.url(ruta), ['booking.ticket_issued']);
      await datos
        .publicar(
          sobre('booking.ticket_issued', dueno, {
            ...ejemplo('booking.ticket_issued', 1),
            eventId: randomUUID(),
            ownerId: dueno,
          }),
        )
        .expect(202);
      await vaciar();
      const feed = await leer(dueno).expect(200);
      expect(feed.body.events).toEqual([JSON.parse(receptor.de(ruta)[0].cuerpo)]);
    });

    it('aislamiento: solo los eventos del dueño del token; el after de otro dueño es 400 como uno inexistente', async () => {
      const a = datos.dueno();
      const b = datos.dueno();
      const deA = sobre('booking.confirmed', a);
      const deB = sobre('booking.confirmed', b);
      await datos.publicar(deA).expect(202);
      await datos.publicar(deB).expect(202);
      const feedB = await leer(b).expect(200);
      expect(feedB.body.events.map((e: { id: string }) => e.id)).toEqual([deB.eventId]);
      const ajeno = await leer(b, { after: deA.eventId as string }).expect(400);
      const inexistente = await leer(b, { after: randomUUID() }).expect(400);
      esperarEsquemaV2('ProblemDetails', ajeno.body);
      expect(ajeno.body.detail).toBe(inexistente.body.detail);
      expect(JSON.stringify(ajeno.body)).not.toContain(deA.eventId as string);
    });

    it('scope flights:read: sin token 401, con flights:webhooks 403, parámetros malos 400 (ProblemDetails v2)', async () => {
      const dueno = datos.dueno();
      const sin = await http().get('/api/v2/vuelos/eventos').expect(401);
      esperarEsquemaV2('ProblemDetails', sin.body);
      const sinScope = await leer(dueno, {}, 'flights:webhooks').expect(403);
      expect(sinScope.body.code).toBe('FORBIDDEN');
      for (const query of [
        { limit: 0 },
        { limit: 101 },
        { limit: 'x' },
        { after: 'no-uuid' },
        { type: 'booking.created' },
      ]) {
        const malo = await leer(dueno, query as unknown as Record<string, string>).expect(400);
        esperarEsquemaV2('ProblemDetails', malo.body);
        expect(malo.body.code).toBe('VALIDATION_FAILED');
      }
    });
  });
});
