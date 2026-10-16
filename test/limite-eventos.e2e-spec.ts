import { NestExpressApplication } from '@nestjs/platform-express';
import * as request from 'supertest';
import { sobre } from './utils/datos';
import { IdentidadFalsa } from './utils/identidad-falsa';
import { LimitesReiniciables } from './utils/limites';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';

/**
 * EVENTS_RATE_LIMIT_MAX: el límite propio de POST /internal/v1/events. La configuración se valida
 * al importar AppModule, así que la variable se fija antes y crear-app se importa después.
 */
describe('EVENTS_RATE_LIMIT_MAX', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  let identidad: IdentidadFalsa;
  let app: NestExpressApplication;

  beforeAll(async () => {
    process.env.EVENTS_RATE_LIMIT_MAX = '5';
    const { crearApp } = await import('./utils/crear-app');
    identidad = await IdentidadFalsa.iniciar(() => reloj.ahora());
    app = await crearApp({ identidad, reloj, limites });
  });
  afterAll(async () => {
    delete process.env.EVENTS_RATE_LIMIT_MAX;
    await app.close();
    await identidad.detener();
  });

  const publicar = (ip: string) =>
    request(app.getHttpServer())
      .post('/internal/v1/events')
      .set('Authorization', `Bearer ${identidad.firmarPublicador()}`)
      .set('X-Forwarded-For', ip)
      .send(sobre('booking.failed', '0b7c9f4e-3d2a-4b1c-8e5f-6a7b8c9d0e1f'));

  it('5 por minuto e IP con EVENTS_RATE_LIMIT_MAX=5: la sexta es 429 con Retry-After', async () => {
    for (let i = 0; i < 5; i++) await publicar('192.0.2.50').expect(202);
    const respuesta = await publicar('192.0.2.50').expect(429);
    esperarProblemDetails(respuesta);
    expect(respuesta.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(respuesta.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    await publicar('192.0.2.51').expect(202);
    reloj.adelantar(1.1);
    await publicar('192.0.2.50').expect(202);
  });
});
