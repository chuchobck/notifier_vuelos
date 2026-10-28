import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Express } from 'express';
import { middlewareContexto, middlewareRequestId } from './common/contexto/contexto.middleware';
import { LoggerJson, nivelesPorEntorno } from './common/logger/logger-json';
import { crearPipeValidacion } from './common/pipes/validacion.pipe';
import { parsearTrustProxy } from './config/proxy';
import { configurarSeguridad } from './config/seguridad';
import { configurarSwagger, RUTA_SWAGGER } from './config/swagger';
import { middlewareContextoTraza, middlewareObservabilidad } from './observabilidad/express';
import { Observabilidad } from './observabilidad/observabilidad';
import { RUTAS_SIN_CACHE } from './routes/index.routes';

export interface OpcionesConfigurarApp {
  /** Logger de la app. Por defecto, JSON a la salida estándar con los niveles del entorno. */
  logger?: LoggerJson | false;
}

/**
 * Todo lo que se configura sobre la app de Nest además de sus módulos. Lo usan `main.ts` y
 * las pruebas e2e, para que probar el servicio sea probar el que de verdad se despliega.
 *
 * El orden de los middlewares importa:
 *   1. observabilidad: el span SERVER y X-Trace-Id, antes que todo (estándar del gateway), con el
 *      contexto de la petición (X-Request-Id) que crea al empezar
 *   2. request id: para que hasta un 413 del parser lleve X-Request-Id
 *   3. helmet, CORS, parser del cuerpo y tipo de contenido (configurarSeguridad)
 *   4. contexto asíncrono y de la traza: después del parser, que los perdería si se abrieran antes
 */
export function configurarApp(app: NestExpressApplication, opciones: OpcionesConfigurarApp = {}) {
  const config = app.get(ConfigService);
  // Antes del primer middleware: de esto depende que `req.ip` sea la IP del cliente
  app.set('trust proxy', parsearTrustProxy(config.get<string>('TRUST_PROXY')));
  // Ninguna respuesta dice con qué está hecho el servicio (helmet también lo quita)
  app.disable('x-powered-by');

  const logger =
    opciones.logger ?? new LoggerJson(undefined, nivelesPorEntorno(config.get('NODE_ENV')));
  app.useLogger(logger);

  const observabilidad = app.get(Observabilidad);
  app.use(middlewareObservabilidad(observabilidad));
  app.use(middlewareRequestId);
  configurarSeguridad(app, RUTAS_SIN_CACHE);
  app.use(middlewareContexto);
  app.use(middlewareContextoTraza(observabilidad));

  app.useGlobalPipes(crearPipeValidacion());

  // La raíz no es una ruta del servicio: lleva a la documentación
  const express: Express = app.getHttpAdapter().getInstance();
  express.get('/', (_req, res) => res.redirect(302, `/${RUTA_SWAGGER}`));
  configurarSwagger(app);
}
