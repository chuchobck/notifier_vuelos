import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { esperarWebhookSubscription } from './utils/contrato';
import { crearApp } from './utils/crear-app';
import { Datos } from './utils/datos';
import { IdentidadFalsa } from './utils/identidad-falsa';
import { LimitesReiniciables } from './utils/limites';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';

/**
 * /flights/v1/webhooks: las pruebas de contrato del core (test/webhook.e2e-spec.ts de
 * backend_vuelos) adaptadas. La API tiene que responder exactamente igual que en el core.
 */
const WEBHOOKS = '/flights/v1/webhooks';
const SECRETO = 'un-secreto-compartido-largo';

/** localhost resuelve a loopback: fuera de producción es un destino permitido. */
const urlNueva = () => `http://localhost:9/hooks/${randomUUID()}`;

describe('/flights/v1/webhooks: registrar, listar y dar de baja', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  let identidad: IdentidadFalsa;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let datos: Datos;
  let cliente: string;
  let otro: string;

  const http = () => request(app.getHttpServer());
  const con = (dueno: string) => `Bearer ${datos.tokenDe(dueno)}`;
  const registrar = (dueno: string, cuerpo: object) =>
    http().post(WEBHOOKS).set('Authorization', con(dueno)).send(cuerpo);
  const eliminar = (dueno: string, id: string) =>
    http().delete(`${WEBHOOKS}/${id}`).set('Authorization', con(dueno));
  const listar = (dueno: string) => http().get(WEBHOOKS).set('Authorization', con(dueno));
  const cuerpo = (cambios: object = {}) => ({
    url: urlNueva(),
    events: ['booking.confirmed', 'hold.expired'],
    secret: SECRETO,
    ...cambios,
  });

  beforeAll(async () => {
    identidad = await IdentidadFalsa.iniciar(() => reloj.ahora());
    app = await crearApp({ identidad, reloj, limites });
    prisma = app.get(PrismaService);
    datos = new Datos(app, identidad);
    cliente = datos.dueno();
    otro = datos.dueno();
  });
  beforeEach(() => limites.reiniciar());
  afterAll(async () => {
    await datos.darDeBaja();
    await app.close();
    await identidad.detener();
  });

  describe('POST', () => {
    it('201 con la suscripción (cumple WebhookSubscription) y el secreto enmascarado', async () => {
      const solicitud = cuerpo({ events: ['hold.expired', 'booking.confirmed'] });
      const respuesta = await registrar(cliente, solicitud).expect(201);
      esperarWebhookSubscription(respuesta.body);
      expect(respuesta.body).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        url: solicitud.url,
        // en el orden del contrato
        events: ['booking.confirmed', 'hold.expired'],
        secret: '****argo',
      });
      expect(respuesta.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(respuesta.body)).not.toContain(SECRETO);
    });

    it('guarda el secreto cifrado (v1.) y la auditoría tiene el actor y el host, nunca el secreto ni la URL', async () => {
      const url = `http://localhost:9/hooks/${randomUUID()}?token=token-del-tercero`;
      const { body } = await registrar(cliente, cuerpo({ url })).expect(201);
      const fila = await prisma.db.suscripcion.findUniqueOrThrow({ where: { id: body.id } });
      expect(fila.secreto_cifrado).toMatch(/^v1\./);
      expect(fila.secreto_cifrado).not.toContain(SECRETO);
      expect(fila.url).toBe(url);
      const auditoria = await prisma.db.auditoria.findMany({ where: { suscripcion_id: body.id } });
      expect(auditoria).toHaveLength(1);
      expect(auditoria[0]).toMatchObject({
        accion: 'SUSCRIPCION_CREADA',
        actor: cliente,
        id_propietario: cliente,
        host_destino: 'localhost:9',
        eventos: ['booking.confirmed', 'hold.expired'],
        direccion_ip: '127.0.0.1',
      });
      expect(auditoria[0].id_peticion).toMatch(/^[0-9a-f-]{36}$/);
      const texto = JSON.stringify(auditoria[0], (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      for (const prohibido of [SECRETO, fila.secreto_cifrado, 'token-del-tercero', '/hooks/']) {
        expect(texto).not.toContain(prohibido);
      }
    });

    it('GET devuelve el secreto enmascarado (se descifra para mostrar sus 4 últimos)', async () => {
      const { body } = await registrar(cliente, cuerpo({ secret: 'otro-secreto-1234567' }));
      const lista = await listar(cliente).expect(200);
      expect(lista.body.find((w: { id: string }) => w.id === body.id).secret).toBe('****4567');
    });

    it.each([
      ['url que no es URL', { url: 'no es una url' }, 'url'],
      ['url con otro protocolo', { url: 'ftp://localhost/hook' }, 'url'],
      ['url con credenciales', { url: 'http://usuario:clave@localhost:9/hook' }, 'url'],
      ['events vacío', { events: [] }, 'events'],
      ['events con un valor que no existe', { events: ['booking.exploded'] }, 'events'],
      ['events con duplicados', { events: ['booking.confirmed', 'booking.confirmed'] }, 'events'],
      ['events que no es lista', { events: 'booking.confirmed' }, 'events'],
      ['secret de 15 caracteres', { secret: 'a'.repeat(15) }, 'secret'],
      ['secret con espacios', { secret: 'un secreto con espacios' }, 'secret'],
      ['secret que no es texto', { secret: 1234567890123456 }, 'secret'],
      ['un campo que el contrato no tiene', { active: true }, 'active'],
    ])('400 con %s, y el error nombra el campo', async (_nombre, cambios, campo) => {
      const respuesta = await registrar(cliente, cuerpo(cambios)).expect(400);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.invalidParams.map((p: { name: string }) => p.name)).toContain(campo);
    });

    it('400 si falta algún campo', async () => {
      for (const campo of ['url', 'events', 'secret']) {
        const { [campo]: _quitado, ...resto } = cuerpo() as Record<string, unknown>;
        await registrar(cliente, resto).expect(400);
      }
    });

    it('el error de validación no repite el secreto ni la URL', async () => {
      const url = 'http://localhost:9/hook?token=supersecretotoken';
      const respuesta = await registrar(cliente, cuerpo({ url, events: [] })).expect(400);
      expect(JSON.stringify(respuesta.body)).not.toContain('supersecretotoken');
      const malo = await registrar(cliente, cuerpo({ secret: 'abcdef-secreto-' })).expect(400);
      expect(JSON.stringify(malo.body)).not.toContain('abcdef-secreto-');
    });

    describe('SSRF: destinos que no se aceptan', () => {
      it.each([
        ['metadata de la nube', 'http://169.254.169.254/latest/meta-data'],
        ['red privada 10/8', 'http://10.0.0.5/hook'],
        ['red privada 172.16/12', 'http://172.16.0.1/hook'],
        ['red privada 192.168/16', 'http://192.168.1.10/hook'],
        ['link-local IPv6', 'http://[fe80::1]/hook'],
        ['IPv6 única local', 'http://[fd00::1]/hook'],
        ['IPv4 dentro de IPv6', 'http://[::ffff:10.0.0.1]/hook'],
        ['esta red', 'http://0.0.0.0/hook'],
        ['operador compartido', 'http://100.64.0.1/hook'],
        ['metadata por https', 'https://169.254.169.254/latest/meta-data'],
      ])('400: %s', async (_nombre, url) => {
        const respuesta = await registrar(cliente, cuerpo({ url })).expect(400);
        esperarProblemDetails(respuesta);
        expect(respuesta.body.invalidParams[0].name).toBe('url');
        // el detalle no repite la URL
        expect(JSON.stringify(respuesta.body)).not.toContain(url.split('/')[2]);
      });

      it('400 si el nombre no se resuelve', async () => {
        const url = `https://no-existe-${randomUUID()}.invalid/hook`;
        const respuesta = await registrar(cliente, cuerpo({ url })).expect(400);
        expect(respuesta.body.invalidParams[0].reason).toBe('host cannot be resolved');
      });

      it('http solo hacia localhost: http a una IP pública se rechaza', async () => {
        const respuesta = await registrar(cliente, cuerpo({ url: 'http://8.8.8.8/hook' })).expect(
          400,
        );
        expect(respuesta.body.invalidParams[0].reason).toBe('must use https');
      });

      it('no deja nada guardado', async () => {
        const antes = await prisma.db.suscripcion.count({ where: { id_propietario: cliente } });
        await registrar(cliente, cuerpo({ url: 'http://10.1.1.1/x' })).expect(400);
        expect(await prisma.db.suscripcion.count({ where: { id_propietario: cliente } })).toBe(
          antes,
        );
      });
    });

    it('409 si el usuario ya tiene esa URL activa; otro usuario sí puede', async () => {
      const solicitud = cuerpo();
      await registrar(cliente, solicitud).expect(201);
      const repetida = await registrar(cliente, solicitud).expect(409);
      esperarProblemDetails(repetida);
      expect(repetida.body.detail).toBe('A webhook with this URL already exists');
      await registrar(otro, solicitud).expect(201);
    });

    it('con la URL de una suscripción dada de baja se puede registrar de nuevo', async () => {
      const solicitud = cuerpo();
      const { body } = await registrar(cliente, solicitud).expect(201);
      await eliminar(cliente, body.id).expect(204);
      await registrar(cliente, solicitud).expect(201);
    });

    it('401 sin token y 403 sin el scope flights:webhooks', async () => {
      await http().post(WEBHOOKS).send(cuerpo()).expect(401);
      const respuesta = await http()
        .post(WEBHOOKS)
        .set('Authorization', `Bearer ${identidad.firmar({ sub: cliente, scope: 'flights:read' })}`)
        .send(cuerpo())
        .expect(403);
      esperarProblemDetails(respuesta);
    });

    it('un cliente OAuth con flights:webhooks también gestiona las suyas (el dueño es su sub)', async () => {
      const sub = randomUUID();
      const token = identidad.firmarCliente('agencia-andina', 'flights:webhooks', { sub });
      const { body } = await http()
        .post(WEBHOOKS)
        .set('Authorization', `Bearer ${token}`)
        .send(cuerpo())
        .expect(201);
      const fila = await prisma.db.suscripcion.findUniqueOrThrow({ where: { id: body.id } });
      expect(fila.id_propietario).toBe(sub);
      await http()
        .delete(`${WEBHOOKS}/${body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
    });

    it('más de 10 altas por minuto desde una IP: 429 con Retry-After; otra IP sigue', async () => {
      const dueno = datos.dueno();
      const desde = (ip: string) =>
        http().post(WEBHOOKS).set('Authorization', con(dueno)).set('X-Forwarded-For', ip);
      for (let i = 0; i < 10; i++) {
        await desde('203.0.113.10')
          .send(cuerpo({ events: ['booking.failed'] }))
          .expect(201);
        await eliminar(dueno, (await listar(dueno)).body[0].id).expect(204);
      }
      const respuesta = await desde('203.0.113.10').send(cuerpo()).expect(429);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(Number(respuesta.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      await desde('203.0.113.11').send(cuerpo()).expect(201);
      reloj.adelantar(1.1);
      await desde('203.0.113.10').send(cuerpo()).expect(201);
    });
  });

  describe('límite de 10 suscripciones activas por usuario', () => {
    it('la 11 responde 409; dar una de baja libera el cupo; es por usuario', async () => {
      const dueno = datos.dueno();
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        ids.push((await registrar(dueno, cuerpo()).expect(201)).body.id);
      }
      limites.reiniciar();
      const excedida = await registrar(dueno, cuerpo()).expect(409);
      esperarProblemDetails(excedida);
      expect(excedida.body.detail).toBe('At most 10 active webhooks per user; delete one first');
      // otro usuario no se ve afectado
      await registrar(otro, cuerpo()).expect(201);
      await eliminar(dueno, ids[0]).expect(204);
      await registrar(dueno, cuerpo()).expect(201);
    });

    it('altas simultáneas no pasan de 10 (candado por usuario)', async () => {
      const dueno = datos.dueno();
      for (let i = 0; i < 8; i++) await registrar(dueno, cuerpo()).expect(201);
      limites.reiniciar();
      const estados = await Promise.all(
        Array.from({ length: 5 }, () => registrar(dueno, cuerpo()).then((r) => r.status)),
      );
      expect(estados.filter((s) => s === 201)).toHaveLength(2);
      expect(estados.filter((s) => s === 409)).toHaveLength(3);
      expect(
        await prisma.db.suscripcion.count({ where: { id_propietario: dueno, activo: true } }),
      ).toBe(10);
    });
  });

  describe('GET', () => {
    it('solo las suscripciones activas del usuario, sin las de otros ni las dadas de baja', async () => {
      const dueno = datos.dueno();
      const a = (await registrar(dueno, cuerpo()).expect(201)).body;
      const b = (await registrar(dueno, cuerpo()).expect(201)).body;
      await registrar(otro, cuerpo()).expect(201);
      await eliminar(dueno, b.id).expect(204);
      const lista = await listar(dueno).expect(200);
      expect(lista.body).toEqual([a]);
      for (const w of lista.body) esperarWebhookSubscription(w);
      expect(lista.headers['cache-control']).toBe('no-store');
    });

    it('un usuario sin suscripciones recibe []', async () => {
      await listar(datos.dueno()).expect(200, []);
    });

    it('401 sin token', async () => {
      await http().get(WEBHOOKS).expect(401);
    });
  });

  describe('DELETE /{id}', () => {
    it('204 y baja lógica: la fila sigue, con activo = false, y queda en la auditoría', async () => {
      const { body } = await registrar(cliente, cuerpo()).expect(201);
      const respuesta = await eliminar(cliente, body.id).expect(204);
      expect(respuesta.text).toBe('');
      const fila = await prisma.db.suscripcion.findUniqueOrThrow({ where: { id: body.id } });
      expect(fila.activo).toBe(false);
      const auditoria = await prisma.db.auditoria.findMany({
        where: { suscripcion_id: body.id, accion: 'SUSCRIPCION_ELIMINADA' },
      });
      expect(auditoria).toHaveLength(1);
      expect(auditoria[0]).toMatchObject({ actor: cliente, host_destino: 'localhost:9' });
    });

    it('404 si es de otro usuario (y no la toca), no existe o ya estaba dada de baja', async () => {
      const { body } = await registrar(cliente, cuerpo()).expect(201);
      const ajena = await eliminar(otro, body.id).expect(404);
      esperarProblemDetails(ajena);
      expect(ajena.body.detail).toBe(`Webhook ${body.id} was not found`);
      expect(
        (await prisma.db.suscripcion.findUniqueOrThrow({ where: { id: body.id } })).activo,
      ).toBe(true);
      expect(
        await prisma.db.auditoria.count({
          where: { suscripcion_id: body.id, accion: 'SUSCRIPCION_ELIMINADA' },
        }),
      ).toBe(0);
      await eliminar(cliente, randomUUID()).expect(404);
      await eliminar(cliente, body.id).expect(204);
      await eliminar(cliente, body.id).expect(404);
    });

    it('400 si el id no es un uuid; 401 sin token', async () => {
      esperarProblemDetails(await eliminar(cliente, 'abc').expect(400));
      await http().delete(`${WEBHOOKS}/${randomUUID()}`).expect(401);
    });
  });
});
