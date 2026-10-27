import { randomBytes } from 'node:crypto';

/**
 * Corre antes de cada archivo de pruebas (setupFiles de jest-e2e.json), antes de que se importe
 * AppModule: ConfigModule valida el entorno al importarse y process.env gana sobre el .env.
 *
 * El emisor y la audiencia son fijos; el JWKS lo sirve una IdentidadFalsa por archivo, en un
 * puerto libre, y crearApp({ identidad }) apunta el verificador a ella. JWKS_URL apunta a un
 * puerto cerrado: una app sin identidad falsa no tiene con qué verificar (503). La clave de los
 * secretos es efímera. La base sí sale del .env (o de DATABASE_URL en CI).
 */
export const EMISOR_PRUEBAS = 'https://identity.e2e.quinde.example';
export const AUDIENCIA_PRUEBAS = 'quinde-vuelos-api';

process.env.NODE_ENV = 'test';
process.env.PORT ??= '3002';
process.env.JWT_ISSUER = EMISOR_PRUEBAS;
process.env.JWT_AUDIENCE = AUDIENCIA_PRUEBAS;
process.env.JWKS_URL = 'http://127.0.0.1:9/.well-known/jwks.json';
process.env.WEBHOOK_SECRET_KEY = randomBytes(48).toString('base64url');
// Las pruebas corren la entrega a mano (EntregaWebhooks.ejecutar), con el reloj de la prueba
process.env.NOTIFIER_DELIVERY_JOB_ENABLED = 'false';
// Un solo origen de navegador, el de la prueba de CORS
process.env.CORS_ORIGINS = 'https://app.e2e.quinde.example';
// X-Forwarded-For desde 127.0.0.1: las pruebas simulan clientes con IP distintas
process.env.TRUST_PROXY = 'loopback';
delete process.env.RATE_LIMIT_MAX;
delete process.env.RATE_LIMIT_WINDOW_SECONDS;
delete process.env.EVENTS_RATE_LIMIT_MAX;
delete process.env.NOTIFIER_DELIVERY_JOB_INTERVAL_SECONDS;
// Sin servidor de /metrics (cada prueba lee el Registry de su app) ni exportador de trazas
process.env.METRICS_PORT = '0';
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_TRACES_SAMPLER_ARG;
delete process.env.OTEL_SERVICE_NAME;
delete process.env.TRACE_TRUST_INCOMING;
