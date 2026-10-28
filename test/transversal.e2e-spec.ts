import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearApp } from './utils/crear-app';
import { sobre } from './utils/datos';
import { IdentidadFalsa } from './utils/identidad-falsa';
import { LimitesReiniciables } from './utils/limites';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';

/** Lo que vale para todo el servicio: salud, X-Request-Id, errores, límites, cabeceras, logs. */
describe('Transversal', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  const logs: string[] = [];
  let identidad: IdentidadFalsa;
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    identidad = await IdentidadFalsa.iniciar(() => reloj.ahora());
    app = await crearApp({ identidad, reloj, limites, logs });
  });
  beforeEach(() => limites.reiniciar());
  afterAll(async () => {
    await app.close();
    await identidad.detener();
  });

  describe('salud', () => {
    it('GET /health: 200 UP sin token', async () => {
      const { body } = await http().get('/health').expect(200);
      expect(body).toEqual({ status: 'UP', timestamp: expect.any(String) });
    });

    it('GET /health/ready: 200 con la base arriba', async () => {
      const { body } = await http().get('/health/ready').expect(200);
      expect(body).toMatchObject({ status: 'UP', database: 'UP' });
    });

    it('GET /health/ready: 503 con la base caída (y /health sigue en 200)', async () => {
      const caida = new PrismaService({
        getOrThrow: () => 'postgresql://nadie:nada@127.0.0.1:9/no_existe?schema=notificaciones',
      } as unknown as ConfigService);
      // Con los mismos logs: el Logger de Nest es global y la última app decide adónde van
      const sinBase = await crearApp({
        identidad,
        logs,
        reemplazos: [{ proveedor: PrismaService, valor: caida }],
      });
      try {
        const respuesta = await request(sinBase.getHttpServer()).get('/health/ready').expect(503);
        esperarProblemDetails(respuesta);
        await request(sinBase.getHttpServer()).get('/health').expect(200);
      } finally {
        await sinBase.close();
      }
    });

    it('las rutas de salud no cuentan en el límite de peticiones', async () => {
      for (let i = 0; i < 120; i++) await http().get('/health').expect(200);
    });
  });

  describe('X-Request-Id', () => {
    it('devuelve el del cliente si es válido y uno nuevo si no', async () => {
      const propio = await http().get('/health').set('X-Request-Id', 'traza-abc-12345678');
      expect(propio.headers['x-request-id']).toBe('traza-abc-12345678');
      const malo = await http().get('/health').set('X-Request-Id', 'con espacios <y> "comillas"');
      expect(malo.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('lo llevan también los errores, y la línea de log de la petición', async () => {
      const respuesta = await http()
        .get('/no-existe')
        .set('X-Request-Id', 'traza-del-error-1234')
        .expect(404);
      expect(respuesta.headers['x-request-id']).toBe('traza-del-error-1234');
      const linea = logs
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l.requestId === 'traza-del-error-1234' && l.context === 'HTTP');
      expect(linea?.message).toBe(
        `GET __unmatched__ 404 ${(linea?.message as string).split(' ')[3]}`,
      );
    });
  });

  describe('errores como ProblemDetails', () => {
    it('404 de una ruta que no existe y 405 con Allow', async () => {
      esperarProblemDetails(await http().get('/flights/v1/nada').expect(404));
      const respuesta = await http()
        .put('/flights/v1/webhooks')
        .set('Authorization', `Bearer ${identidad.firmar()}`)
        .expect(405);
      esperarProblemDetails(respuesta);
      expect(respuesta.headers.allow).toBe('GET, POST');
    });

    it('415 si el cuerpo no es JSON; 400 con JSON roto; 413 con más de 100 kB', async () => {
      const token = identidad.firmar();
      esperarProblemDetails(
        await http()
          .post('/flights/v1/webhooks')
          .set('Authorization', `Bearer ${token}`)
          .set('Content-Type', 'application/xml')
          .send('<a/>')
          .expect(415),
      );
      esperarProblemDetails(
        await http()
          .post('/flights/v1/webhooks')
          .set('Authorization', `Bearer ${token}`)
          .set('Content-Type', 'application/json')
          .send('{"url":')
          .expect(400),
      );
      const grande = sobre('booking.confirmed', '0b7c9f4e-3d2a-4b1c-8e5f-6a7b8c9d0e1f', {
        relleno: 'x'.repeat(110_000),
      });
      const respuesta = await http()
        .post('/internal/v1/events')
        .set('Authorization', `Bearer ${identidad.firmarPublicador()}`)
        .send(grande)
        .expect(413);
      esperarProblemDetails(respuesta);
      expect(respuesta.headers['x-request-id']).toBeDefined();
    });
  });

  describe('cabeceras de seguridad', () => {
    it('helmet sí, x-powered-by no; no-store en la API', async () => {
      const respuesta = await http()
        .get('/flights/v1/webhooks')
        .set('Authorization', `Bearer ${identidad.firmar()}`)
        .expect(200);
      expect(respuesta.headers['x-content-type-options']).toBe('nosniff');
      expect(respuesta.headers['content-security-policy']).toBeDefined();
      expect(respuesta.headers['x-powered-by']).toBeUndefined();
      expect(respuesta.headers['cache-control']).toBe('no-store');
    });

    it('CORS solo para los orígenes de CORS_ORIGINS', async () => {
      const permitido = await http()
        .options('/flights/v1/webhooks')
        .set('Origin', 'https://app.e2e.quinde.example')
        .set('Access-Control-Request-Method', 'DELETE');
      expect(permitido.headers['access-control-allow-origin']).toBe(
        'https://app.e2e.quinde.example',
      );
      expect(permitido.headers['access-control-allow-methods']).toContain('DELETE');
      const ajeno = await http()
        .options('/flights/v1/webhooks')
        .set('Origin', 'https://otro.example')
        .set('Access-Control-Request-Method', 'GET');
      expect(ajeno.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('límite de peticiones', () => {
    it('100 por minuto e IP en la API pública; la 101 es 429 con Retry-After', async () => {
      const token = identidad.firmar();
      const desde = (ip: string) =>
        http()
          .get('/flights/v1/webhooks')
          .set('Authorization', `Bearer ${token}`)
          .set('X-Forwarded-For', ip);
      for (let i = 0; i < 100; i++) await desde('198.51.100.7').expect(200);
      const respuesta = await desde('198.51.100.7').expect(429);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(Number(respuesta.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      // Otra IP no se ve afectada; y pasado el minuto, la primera vuelve
      await desde('198.51.100.8').expect(200);
      reloj.adelantar(1.1);
      await desde('198.51.100.7').expect(200);
    });

    it('la API interna de eventos no cuenta en ese límite: el core publica en ráfagas', async () => {
      const token = identidad.firmar();
      for (let i = 0; i < 100; i++) {
        await http()
          .get('/flights/v1/webhooks')
          .set('Authorization', `Bearer ${token}`)
          .set('X-Forwarded-For', '198.51.100.9')
          .expect(200);
      }
      for (let i = 0; i < 150; i++) {
        await http()
          .post('/internal/v1/events')
          .set('Authorization', `Bearer ${identidad.firmarPublicador()}`)
          .set('X-Forwarded-For', '198.51.100.9')
          .send(sobre('booking.failed', '0b7c9f4e-3d2a-4b1c-8e5f-6a7b8c9d0e1f'))
          .expect(202);
      }
    }, 60_000);
  });

  describe('documentación', () => {
    it('Swagger en /api/docs; la raíz lleva ahí', async () => {
      await http().get('/api/docs/').expect(200);
      const raiz = await http().get('/').expect(302);
      expect(raiz.headers.location).toBe('/api/docs');
    });
  });

  describe('logs', () => {
    it('una línea JSON por mensaje, con nivel, contexto y request id', () => {
      const lineas = logs.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lineas.length).toBeGreaterThan(10);
      for (const linea of lineas) {
        expect(typeof linea.time).toBe('string');
        expect(typeof linea.level).toBe('string');
        expect(typeof linea.message).toBe('string');
      }
      expect(lineas.some((l) => l.context === 'HTTP' && typeof l.requestId === 'string')).toBe(
        true,
      );
    });
  });
});
