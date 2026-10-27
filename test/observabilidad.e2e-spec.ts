import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { ClienteWebhookHttp } from '../src/modules/entrega/cliente-webhook-http';
import { EntregaWebhooks } from '../src/modules/entrega/entrega-webhooks';
import { ATRIBUTOS_PERMITIDOS } from '../src/observabilidad/atributos';
import { Observabilidad } from '../src/observabilidad/observabilidad';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearApp } from './utils/crear-app';
import { Datos, sobre } from './utils/datos';
import { IdentidadFalsa } from './utils/identidad-falsa';
import { LimitesReiniciables } from './utils/limites';
import { Receptor } from './utils/receptor';
import { RecolectorOtlp } from './utils/recolector-otlp';
import { RelojDePrueba } from './utils/reloj';

/** 2 SERVER, 3 CLIENT (OTLP SpanKind). */
const SERVER = 2;
const CLIENT = 3;

/**
 * El estándar de observabilidad (docs/OBSERVABILIDAD.md de gateway_vuelos) en el notifier: la
 * traza del relevo del core continúa en la recepción del evento y llega a cada entrega como span
 * CLIENT (sin mandar traceparent al tercero), las métricas tienen cardinalidad acotada y nada
 * sensible llega a logs, spans ni métricas. Los spans van a un recolector OTLP/HTTP falso.
 */
describe('Observabilidad (fase 7e)', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  const recolector = new RecolectorOtlp();
  const logs: string[] = [];
  let identidad: IdentidadFalsa;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let entrega: EntregaWebhooks;
  let receptor: Receptor;
  let datos: Datos;
  let obs: Observabilidad;

  const vaciar = async () => {
    for (let i = 0; i < 50; i++) {
      const r = await entrega.ejecutar();
      if (r.entregadas + r.reintentos + r.fallidas === 0) return;
    }
  };

  beforeAll(async () => {
    await recolector.iniciar();
    // Solo esta app exporta (la configuración se lee al crear Observabilidad)
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = recolector.url;
    identidad = await IdentidadFalsa.iniciar(() => reloj.ahora());
    receptor = new Receptor();
    await receptor.iniciar();
    const http: { real?: ClienteWebhookHttp } = {};
    app = await crearApp({
      identidad,
      reloj,
      limites,
      logs,
      clienteWebhook: { enviar: (p) => (http.real as ClienteWebhookHttp).enviar(p) },
    });
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    http.real = new ClienteWebhookHttp(app.get(ConfigService));
    prisma = app.get(PrismaService);
    entrega = app.get(EntregaWebhooks);
    obs = app.get(Observabilidad);
    datos = new Datos(app, identidad);
    await vaciar();
  });

  afterAll(async () => {
    await datos.darDeBaja();
    reloj.adelantar(60 * 24 * 2);
    await vaciar();
    await app.close();
    await receptor.detener();
    await identidad.detener();
    await recolector.detener();
  });

  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
    receptor.recibidos = [];
  });

  it('continúa la traza del relevo del core hasta la entrega: SERVER hijo del traceparent, CLIENT hijo del SERVER', async () => {
    const traceId = randomBytes(16).toString('hex');
    const delRelevo = randomBytes(8).toString('hex');
    const dueno = datos.dueno();
    const ruta = `/traza/${randomUUID()}`;
    await datos.suscribirV2(dueno, receptor.url(ruta), ['booking.confirmed']);
    const evento = sobre('booking.confirmed', dueno);
    const respuesta = await datos
      .publicar(evento)
      .set('traceparent', `00-${traceId}-${delRelevo}-01`)
      .expect(202);
    expect(respuesta.headers['x-trace-id']).toBe(traceId);
    const fila = await prisma.db.evento.findUnique({
      where: { id_evento: evento.eventId as string },
    });
    expect(fila?.traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));

    await vaciar();
    const spans = await recolector.esperarTraza(traceId, 2, 8000);
    const servidor = spans.find((s) => s.tipo === SERVER);
    const cliente = spans.find((s) => s.tipo === CLIENT);
    expect(servidor).toMatchObject({
      servicio: 'quinde-notifier',
      nombre: 'POST /internal/v1/events',
      parentSpanId: delRelevo,
    });
    expect(fila?.traceparent).toBe(`00-${traceId}-${servidor?.spanId}-01`);
    expect(cliente).toMatchObject({ nombre: 'POST webhook', parentSpanId: servidor?.spanId });
    expect(cliente?.atributos).toEqual({
      'http.request.method': 'POST',
      'http.response.status_code': 200,
    });
    // Al tercero no le llega la traza
    const [recibido] = receptor.de(ruta);
    expect(recibido.cabeceras.traceparent).toBeUndefined();
    expect(recibido.cabeceras.tracestate).toBeUndefined();
    // La línea del intento lleva el traceId de su span CLIENT
    const linea = logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.context === 'EntregaWebhooks' && l.spanId === cliente?.spanId);
    expect(linea?.traceId).toBe(traceId);
  });

  it('un traceparent inválido no rompe nada: traza nueva', async () => {
    const respuesta = await request(app.getHttpServer())
      .get('/health')
      .set('traceparent', '00-ZZZ-no-vale-01')
      .expect(200);
    expect(respuesta.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('cardinalidad acotada: 30 ids distintos son UNA serie, y notifier_* solo con valores de listas cerradas', async () => {
    const dueno = datos.dueno();
    for (let i = 0; i < 30; i++) {
      await request(app.getHttpServer())
        .delete(`/api/v2/vuelos/webhooks/${randomUUID()}`)
        .set('Authorization', `Bearer ${datos.tokenDe(dueno)}`)
        .expect(404);
    }
    const texto = await obs.metricas.exponer();
    const series = texto
      .split('\n')
      .filter((l) => l.startsWith('http_server_requests_total{') && l.includes('method="DELETE"'));
    expect(series).toEqual([
      'http_server_requests_total{method="DELETE",route="/api/v2/vuelos/webhooks/{id}",status="404"} 30',
    ]);
    expect(texto).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    const etiquetas = [...texto.matchAll(/^notifier_[a-z_]+\{([^}]*)\}/gm)].flatMap((m) =>
      m[1].split(',').map((par) => par.split('=') as [string, string]),
    );
    const permitidas: Record<string, string[]> = {
      result: ['delivered', 'retry', 'failed', 'accepted', 'duplicate'],
      format: ['v1', 'v2'],
      le: [],
    };
    for (const [nombre, valor] of etiquetas) {
      expect(Object.keys(permitidas)).toContain(nombre);
      if (nombre !== 'le') expect(permitidas[nombre]).toContain(valor.replace(/"/g, ''));
    }
    expect(texto).toMatch(/^notifier_deliveries_total\{result="delivered",format="v2"\} \d+/m);
    expect(texto).toMatch(/^notifier_deliveries_pending \d+/m);
    expect(texto).toMatch(/^notifier_deliveries_oldest_pending_seconds \d+/m);
    expect(texto).toMatch(/^notifier_events_received_total\{result="accepted"\} \d+/m);
    expect(texto).toMatch(/^quinde_build_info\{service="quinde-notifier"/m);
  });

  it('escaneo: ni el secreto, ni la URL, ni la firma, ni el token, ni el PNR en logs, spans o métricas', async () => {
    const dueno = datos.dueno();
    const secreto = `secreto-escaneo-${randomUUID()}`;
    const ruta = `/escaneo/${randomUUID()}`;
    const url = `${receptor.url(ruta)}?token=token-del-tercero-${randomUUID()}`;
    await datos.suscribirV2(dueno, url, ['booking.cancelled'], secreto);
    const pnr = 'ZQ9X7W';
    const evento = sobre('booking.cancelled', dueno, {
      data: {
        bookingId: randomUUID(),
        pnr,
        status: 'CANCELLED',
        refundAmount: '35.00',
      },
    });
    const tokenCore = identidad.firmarPublicador();
    await datos.publicar(evento, tokenCore).expect(202);
    await vaciar();
    const [recibido] = receptor.recibidos.filter((r) => r.ruta.startsWith(ruta));
    const firma = recibido.cabeceras['x-webhook-signature'] as string;
    await recolector.esperar(recolector.spans.length + 1, 3000);
    const todo = [...logs, ...recolector.cuerpos, await obs.metricas.exponer()].join('\n');
    for (const prohibido of [
      secreto,
      url,
      ruta,
      'token-del-tercero',
      firma,
      firma.replace('sha256=', ''),
      tokenCore,
      tokenCore.split('.')[2],
      pnr,
      recibido.cuerpo,
    ]) {
      expect(todo).not.toContain(prohibido);
    }
    // Ningún span lleva un atributo fuera de la lista del estándar (y sí hubo spans que revisar)
    expect(recolector.spans.length).toBeGreaterThan(0);
    for (const span of recolector.spans) {
      for (const atributo of Object.keys(span.atributos)) {
        expect(ATRIBUTOS_PERMITIDOS.has(atributo)).toBe(true);
      }
    }
  });
});
