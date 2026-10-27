import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { EVENTOS_WEBHOOK } from '../src/modules/compartido/eventos-webhook';
import { EventoRepository } from '../src/modules/evento/evento.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { esperarWebhookPayload } from './utils/contrato';
import { crearApp } from './utils/crear-app';
import { Datos, ejemplo, sobre } from './utils/datos';
import { IdentidadFalsa } from './utils/identidad-falsa';
import { LimitesReiniciables } from './utils/limites';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';

/**
 * POST /internal/v1/events: validación contra el esquema versionado, idempotencia por eventId,
 * reparto a las suscripciones (solo las del dueño, solo las que escuchan el tipo, ninguna
 * inactiva) y el WebhookPayload congelado, todo en una transacción.
 */
describe('POST /internal/v1/events', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  let identidad: IdentidadFalsa;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let datos: Datos;
  const destino = (ruta: string) => `http://127.0.0.1:9/${ruta}`;

  beforeAll(async () => {
    identidad = await IdentidadFalsa.iniciar(() => reloj.ahora());
    app = await crearApp({ identidad, reloj, limites });
    prisma = app.get(PrismaService);
    datos = new Datos(app, identidad);
  });

  afterAll(async () => {
    await datos.darDeBaja();
    await app.close();
    await identidad.detener();
  });

  beforeEach(() => limites.reiniciar());

  const entregasDe = (eventId: string) =>
    prisma.db.entrega.findMany({
      where: { id_evento: eventId },
      select: { suscripcion_id: true, estado: true, intentos: true, cuerpo: true },
      orderBy: { id: 'asc' },
    });

  describe('caso feliz', () => {
    it('202 con las entregas creadas, el evento guardado y una entrega PENDIENTE por suscripción', async () => {
      const dueno = datos.dueno();
      const a = await datos.suscribir(dueno, destino('a'), ['booking.confirmed']);
      const b = await datos.suscribir(dueno, destino('b'), ['booking.confirmed', 'hold.expired']);
      const evento = sobre('booking.confirmed', dueno);

      const respuesta = await datos.publicar(evento).expect(202);
      expect(respuesta.body).toEqual({
        eventId: evento.eventId,
        deliveries: 2,
        duplicate: false,
      });
      expect(respuesta.headers['cache-control']).toBe('no-store');

      const guardado = await prisma.db.evento.findUniqueOrThrow({
        where: { id_evento: evento.eventId as string },
      });
      expect(guardado).toMatchObject({
        tipo: 'booking.confirmed',
        version_esquema: '1.0',
        id_propietario: dueno,
        payload: evento.data,
        publicado_por: 'core-vuelos',
      });
      expect(guardado.ocurrido_en.toISOString()).toBe('2026-10-16T14:30:00.000Z');
      expect(guardado.recibido_en.getTime()).toBe(reloj.ahora().getTime());

      const entregas = await entregasDe(evento.eventId as string);
      expect(entregas.map((e) => e.suscripcion_id).sort()).toEqual([a.id, b.id].sort());
      expect(entregas.every((e) => e.estado === 'PENDIENTE' && e.intentos === 0)).toBe(true);
    });

    it.each(EVENTOS_WEBHOOK)('%s: el ejemplo de su esquema v1 se acepta (202)', async (tipo) => {
      const dueno = datos.dueno();
      await datos.suscribir(dueno, destino(tipo), [tipo]);
      const respuesta = await datos.publicar(sobre(tipo, dueno)).expect(202);
      expect(respuesta.body.deliveries).toBe(1);
    });

    it('un dueño sin suscripciones: 202 con 0 entregas (el evento igual queda guardado)', async () => {
      const evento = sobre('booking.failed', datos.dueno());
      const respuesta = await datos.publicar(evento).expect(202);
      expect(respuesta.body.deliveries).toBe(0);
      expect(await prisma.db.evento.count({ where: { id_evento: evento.eventId as string } })).toBe(
        1,
      );
    });
  });

  describe('idempotencia por eventId', () => {
    it('la repetición responde 200 duplicate y no duplica ni el evento ni las entregas', async () => {
      const dueno = datos.dueno();
      await datos.suscribir(dueno, destino('idem'), ['booking.cancelled']);
      const evento = sobre('booking.cancelled', dueno);

      await datos.publicar(evento).expect(202);
      const repetida = await datos.publicar(evento).expect(200);
      expect(repetida.body).toEqual({ eventId: evento.eventId, deliveries: 1, duplicate: true });
      await datos.publicar(evento).expect(200);

      expect(await prisma.db.evento.count({ where: { id_evento: evento.eventId as string } })).toBe(
        1,
      );
      expect(await entregasDe(evento.eventId as string)).toHaveLength(1);
    });

    it('el orden de las claves no cambia el contenido: también es 200', async () => {
      const dueno = datos.dueno();
      const evento = sobre('booking.changed', dueno);
      await datos.publicar(evento).expect(202);
      const alReves = Object.fromEntries(Object.entries(evento).reverse());
      alReves.data = Object.fromEntries(
        Object.entries(evento.data as Record<string, unknown>).reverse(),
      );
      await datos.publicar(alReves).expect(200);
    });

    it('el mismo eventId con otro contenido es 409 y lo guardado no cambia', async () => {
      const dueno = datos.dueno();
      await datos.suscribir(dueno, destino('conflicto'), ['booking.confirmed']);
      const evento = sobre('booking.confirmed', dueno);
      await datos.publicar(evento).expect(202);

      const otro = { ...evento, data: { ...(evento.data as object), pnr: 'ZZZZZZ' } };
      const respuesta = await datos.publicar(otro).expect(409);
      esperarProblemDetails(respuesta);
      const guardado = await prisma.db.evento.findUniqueOrThrow({
        where: { id_evento: evento.eventId as string },
      });
      expect((guardado.payload as { pnr: string }).pnr).toBe('Q7K2MX');
      const [entrega] = await entregasDe(evento.eventId as string);
      expect((entrega.cuerpo as { data: { pnr: string } }).data.pnr).toBe('Q7K2MX');
    });

    it('publicaciones simultáneas del mismo eventId: una 202, las demás 200 y nada duplicado', async () => {
      const dueno = datos.dueno();
      await datos.suscribir(dueno, destino('sim-1'), ['booking.checked_in']);
      await datos.suscribir(dueno, destino('sim-2'), ['booking.checked_in']);
      const evento = sobre('booking.checked_in', dueno);

      const respuestas = await Promise.all(Array.from({ length: 8 }, () => datos.publicar(evento)));
      const codigos = respuestas.map((r) => r.status).sort();
      expect(codigos).toEqual([200, 200, 200, 200, 200, 200, 200, 202]);
      expect(respuestas.every((r) => r.body.deliveries === 2)).toBe(true);
      expect(await prisma.db.evento.count({ where: { id_evento: evento.eventId as string } })).toBe(
        1,
      );
      expect(await entregasDe(evento.eventId as string)).toHaveLength(2);
    });
  });

  describe('esquema', () => {
    const dueno = randomUUID();
    const invalido = async (cuerpo: unknown, campo: string) => {
      const respuesta = await datos.publicar(cuerpo).expect(400);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.invalidParams).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: campo })]),
      );
      return respuesta;
    };

    it('400 si falta un campo obligatorio del sobre o de data', async () => {
      const sinOwner = sobre('booking.confirmed', dueno);
      delete sinOwner.ownerId;
      await invalido(sinOwner, 'ownerId');
      const sinPnr = sobre('booking.confirmed', dueno);
      delete (sinPnr.data as Record<string, unknown>).pnr;
      await invalido(sinPnr, 'data.pnr');
      const sinSegmento = sobre('flight.cancelled', dueno);
      delete (sinSegmento.data as Record<string, unknown>).segmentId;
      await invalido(sinSegmento, 'data.segmentId');
    });

    it('400 con un campo de más en el sobre o en data (nada sin declarar llega al tercero)', async () => {
      await invalido({ ...sobre('booking.confirmed', dueno), traceId: 'x' }, 'traceId');
      const conNombre = sobre('booking.confirmed', dueno);
      (conNombre.data as Record<string, unknown>).passengerName = 'Ana Pérez';
      await invalido(conNombre, 'data.passengerName');
    });

    it('400 con un formato inválido: eventId u ownerId que no son uuid, pnr, status, refundAmount', async () => {
      await invalido(sobre('booking.confirmed', dueno, { eventId: 'no-es-uuid' }), 'eventId');
      await invalido(sobre('booking.confirmed', dueno, { ownerId: 'ana@correo.ec' }), 'ownerId');
      const pnr = sobre('booking.confirmed', dueno);
      (pnr.data as Record<string, unknown>).pnr = 'abc';
      await invalido(pnr, 'data.pnr');
      const estado = sobre('booking.confirmed', dueno);
      (estado.data as Record<string, unknown>).status = 'BOOKED';
      await invalido(estado, 'data.status');
      const monto = sobre('booking.cancelled', dueno);
      (monto.data as Record<string, unknown>).refundAmount = 35;
      await invalido(monto, 'data.refundAmount');
    });

    it('400 si occurredAt no está en UTC (con desfase) o no es una fecha', async () => {
      await invalido(
        sobre('booking.confirmed', dueno, { occurredAt: '2026-10-16T09:30:00-05:00' }),
        'occurredAt',
      );
      await invalido(sobre('booking.confirmed', dueno, { occurredAt: 'ayer' }), 'occurredAt');
      await invalido(
        sobre('booking.confirmed', dueno, { occurredAt: '2026-02-30T10:00:00Z' }),
        'occurredAt',
      );
    });

    it('400 si el cuerpo no es un objeto o le falta eventType; schemaVersion mal escrita también', async () => {
      await invalido([sobre('booking.confirmed', dueno)], 'body');
      const sinTipo = sobre('booking.confirmed', dueno);
      delete sinTipo.eventType;
      await invalido(sinTipo, 'eventType');
      await invalido(sobre('booking.confirmed', dueno, { schemaVersion: 'v1' }), 'schemaVersion');
      await invalido(sobre('booking.confirmed', dueno, { schemaVersion: 1 }), 'schemaVersion');
    });

    it('el error nombra el campo y no repite el valor recibido', async () => {
      const evento = sobre('booking.confirmed', dueno);
      (evento.data as Record<string, unknown>).pnr = 'Ana Pérez 0912345678';
      const respuesta = await invalido(evento, 'data.pnr');
      expect(JSON.stringify(respuesta.body)).not.toContain('Ana Pérez');
      expect(JSON.stringify(respuesta.body)).not.toContain('0912345678');
    });

    it('422 con un eventType que no es de los 15', async () => {
      for (const tipo of ['booking.created', 'payment.captured', 'BOOKING.CONFIRMED']) {
        const respuesta = await datos
          .publicar(sobre('booking.confirmed', dueno, { eventType: tipo }))
          .expect(422);
        esperarProblemDetails(respuesta);
        expect(respuesta.body.invalidParams[0].name).toBe('eventType');
        expect(JSON.stringify(respuesta.body)).not.toContain('payment.captured');
      }
    });

    it('422 con una schemaVersion sin esquema (1.2 todavía no, 2.0 no existe)', async () => {
      for (const version of ['1.2', '2.0', '9.9']) {
        const respuesta = await datos
          .publicar(sobre('booking.confirmed', dueno, { schemaVersion: version }))
          .expect(422);
        expect(respuesta.body.invalidParams[0]).toEqual({
          name: 'schemaVersion',
          reason: 'unsupported version for this eventType; supported: 1.0, 1.1',
        });
      }
    });

    it('un evento rechazado no deja nada guardado', async () => {
      const evento = sobre('booking.confirmed', dueno, { schemaVersion: '2.0' });
      await datos.publicar(evento).expect(422);
      expect(await prisma.db.evento.count({ where: { id_evento: evento.eventId as string } })).toBe(
        0,
      );
    });

    it('415 si no es application/json', async () => {
      const respuesta = await request(app.getHttpServer())
        .post('/internal/v1/events')
        .set('Authorization', `Bearer ${identidad.firmarPublicador()}`)
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify(sobre('booking.confirmed', dueno)))
        .expect(415);
      esperarProblemDetails(respuesta);
    });
  });

  describe('reparto', () => {
    it('solo a las suscripciones del dueño: otro dueño con el mismo tipo no recibe', async () => {
      const dueno = datos.dueno();
      const otro = datos.dueno();
      const propia = await datos.suscribir(dueno, destino('propia'), ['booking.confirmed']);
      await datos.suscribir(otro, destino('propia'), ['booking.confirmed']);
      const evento = sobre('booking.confirmed', dueno);
      await datos.publicar(evento).expect(202);
      expect((await entregasDe(evento.eventId as string)).map((e) => e.suscripcion_id)).toEqual([
        propia.id,
      ]);
    });

    it('solo a las que escuchan ese tipo', async () => {
      const dueno = datos.dueno();
      const escucha = await datos.suscribir(dueno, destino('escucha'), ['hold.expired']);
      await datos.suscribir(dueno, destino('no-escucha'), ['booking.confirmed', 'booking.failed']);
      const evento = sobre('hold.expired', dueno);
      const respuesta = await datos.publicar(evento).expect(202);
      expect(respuesta.body.deliveries).toBe(1);
      expect((await entregasDe(evento.eventId as string)).map((e) => e.suscripcion_id)).toEqual([
        escucha.id,
      ]);
    });

    it('ninguna inactiva: una suscripción dada de baja no recibe el evento', async () => {
      const dueno = datos.dueno();
      const activa = await datos.suscribir(dueno, destino('activa'), ['booking.ticket_issued']);
      const baja = await datos.suscribir(dueno, destino('baja'), ['booking.ticket_issued']);
      await request(app.getHttpServer())
        .delete(`/flights/v1/webhooks/${baja.id}`)
        .set('Authorization', `Bearer ${datos.tokenDe(dueno)}`)
        .expect(204);
      const evento = sobre('booking.ticket_issued', dueno);
      await datos.publicar(evento).expect(202);
      expect((await entregasDe(evento.eventId as string)).map((e) => e.suscripcion_id)).toEqual([
        activa.id,
      ]);
    });

    it('una suscripción creada después del evento no recibe ese evento', async () => {
      const dueno = datos.dueno();
      const evento = sobre('booking.confirmed', dueno);
      await datos.publicar(evento).expect(202);
      await datos.suscribir(dueno, destino('tarde'), ['booking.confirmed']);
      await datos.publicar(evento).expect(200);
      expect(await entregasDe(evento.eventId as string)).toHaveLength(0);
    });
  });

  describe('cuerpo congelado', () => {
    it('es el WebhookPayload del contrato: eventId, eventType, occurredAt UTC con ms, apiVersion 1.5.0 y data', async () => {
      const dueno = datos.dueno();
      await datos.suscribir(dueno, destino('cuerpo'), ['booking.cancelled']);
      const evento = sobre('booking.cancelled', dueno, { occurredAt: '2026-10-16T14:30:00Z' });
      await datos.publicar(evento).expect(202);

      const [entrega] = await entregasDe(evento.eventId as string);
      expect(entrega.cuerpo).toEqual({
        eventId: evento.eventId,
        eventType: 'booking.cancelled',
        occurredAt: '2026-10-16T14:30:00.000Z',
        apiVersion: '1.5.0',
        data: ejemplo('booking.cancelled').data,
      });
      esperarWebhookPayload(entrega.cuerpo);
      // Ni el dueño ni la versión del sobre llegan al tercero
      expect(Object.keys(entrega.cuerpo as object)).not.toContain('ownerId');
      expect(Object.keys(entrega.cuerpo as object)).not.toContain('schemaVersion');
    });

    it('no cambia después: ni con otra publicación ni al cambiar las suscripciones del dueño', async () => {
      const dueno = datos.dueno();
      const suscripcion = await datos.suscribir(dueno, destino('fija'), ['booking.confirmed']);
      const evento = sobre('booking.confirmed', dueno);
      await datos.publicar(evento).expect(202);
      const antes = (await entregasDe(evento.eventId as string))[0].cuerpo;

      await datos
        .publicar(
          sobre('booking.confirmed', dueno, {
            data: { ...(evento.data as object), status: 'CANCELLED' },
          }),
        )
        .expect(202);
      await request(app.getHttpServer())
        .delete(`/flights/v1/webhooks/${suscripcion.id}`)
        .set('Authorization', `Bearer ${datos.tokenDe(dueno)}`)
        .expect(204);
      await datos.suscribir(dueno, destino('fija'), ['booking.confirmed']);

      expect((await entregasDe(evento.eventId as string))[0].cuerpo).toEqual(antes);
    });
  });

  describe('una sola transacción', () => {
    it('si el reparto falla, no queda ni el evento (500) y el reintento del core sí entra (202)', async () => {
      const dueno = datos.dueno();
      await datos.suscribir(dueno, destino('atomico'), ['booking.confirmed']);
      const evento = sobre('booking.confirmed', dueno);
      const repositorio = app.get(EventoRepository);
      const original = repositorio.repartir.bind(repositorio);
      const espia = jest
        .spyOn(repositorio, 'repartir')
        .mockRejectedValueOnce(new Error('falla simulada a mitad de la transacción'));
      try {
        const respuesta = await datos.publicar(evento).expect(500);
        esperarProblemDetails(respuesta);
        expect(respuesta.body.detail).toBeUndefined();
        expect(
          await prisma.db.evento.count({ where: { id_evento: evento.eventId as string } }),
        ).toBe(0);
      } finally {
        espia.mockImplementation(original);
      }
      const reintento = await datos.publicar(evento).expect(202);
      expect(reintento.body.deliveries).toBe(1);
      espia.mockRestore();
    });

    it('con el 202 en la mano, el evento y sus entregas ya se ven desde otra conexión', async () => {
      const dueno = datos.dueno();
      await datos.suscribir(dueno, destino('commit'), ['booking.baggage_added']);
      const evento = sobre('booking.baggage_added', dueno);
      await datos.publicar(evento).expect(202);
      const [fila] = await prisma.db.$queryRaw<Array<{ entregas: number }>>`
        SELECT count(*)::int AS entregas FROM notificaciones.entrega
         WHERE id_evento = ${evento.eventId as string}::uuid`;
      expect(fila.entregas).toBe(1);
    });
  });
});
