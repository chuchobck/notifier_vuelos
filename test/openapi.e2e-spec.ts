import { NestExpressApplication } from '@nestjs/platform-express';
import { readFileSync } from 'node:fs';
import * as request from 'supertest';
import { ARCHIVO_OPENAPI, serializarOpenApi } from '../src/cli/exportar-openapi';
import { crearDocumentoOpenApi } from '../src/config/swagger';
import { crearApp } from './utils/crear-app';

/**
 * contracts/notifier-openapi.json tiene que ser exactamente el documento que genera el código:
 * si alguien cambia un controller o un DTO y no corre `npm run openapi:export`, esto falla.
 */
describe('Contrato OpenAPI versionado', () => {
  let app: NestExpressApplication;
  const versionado = () =>
    JSON.parse(readFileSync(ARCHIVO_OPENAPI, 'utf8')) as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };

  beforeAll(async () => {
    app = await crearApp();
  });

  afterAll(() => app.close());

  it('contracts/notifier-openapi.json está al día (si no: npm run openapi:export)', () => {
    expect(readFileSync(ARCHIVO_OPENAPI, 'utf8')).toBe(
      serializarOpenApi(crearDocumentoOpenApi(app)),
    );
  });

  it('es el mismo documento que sirve /api/docs-json', async () => {
    const { body } = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect(body).toEqual(versionado());
  });

  it('documenta las rutas del servicio y nada más', () => {
    expect(Object.keys(versionado().paths).sort()).toEqual([
      '/api/v2/vuelos/eventos',
      '/api/v2/vuelos/webhooks',
      '/api/v2/vuelos/webhooks/{id}',
      '/flights/v1/webhooks',
      '/flights/v1/webhooks/{id}',
      '/health',
      '/health/ready',
      '/internal/v1/events',
    ]);
  });

  it('/flights/v1/webhooks lleva la etiqueta Webhooks del contrato del core', () => {
    const webhooks = versionado().paths['/flights/v1/webhooks'];
    expect(webhooks.get.tags).toEqual(['Webhooks']);
    expect(webhooks.post.tags).toEqual(['Webhooks']);
  });
});
