import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { CODIGO_SIN_EQUIVALENTE } from '../common/errores/codigo-error';
import { ErrorNegocio } from '../common/errores/error-negocio';
import { listarOrigenes } from './origenes-cors';

/** Tope del cuerpo de una petición. Más grande responde 413. */
export const LIMITE_CUERPO = '100kb';

/** Cabeceras que un navegador puede enviar a este servicio desde un origen permitido. */
const CABECERAS_PERMITIDAS = ['Authorization', 'Content-Type', 'X-Request-Id'];

/** Cabeceras de la respuesta que el navegador deja leer al código del origen permitido. */
const CABECERAS_EXPUESTAS = [
  'X-Request-Id',
  'X-Trace-Id',
  'Retry-After',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
];

/**
 * Seguridad HTTP de la app: helmet, CORS por lista de orígenes, tope del cuerpo y tipo de
 * contenido. Va antes de las rutas; los errores que genere (413, 415) los da el filtro global.
 */
export function configurarSeguridad(
  app: NestExpressApplication,
  rutasSinCache: readonly string[] = [],
): void {
  const config = app.get(ConfigService);
  const enProduccion = config.get<string>('NODE_ENV') === 'production';

  // Helmet con su política por defecto. Swagger UI en /api/docs funciona con ella.
  // `upgrade-insecure-requests` solo se deja en producción: en http://localhost el navegador
  // subiría los recursos a https y Swagger UI no cargaría.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: enProduccion ? {} : { 'upgrade-insecure-requests': null },
      },
    }),
  );

  // Una lista vacía no deja pasar ningún origen. No se usan cookies, así que no hay
  // `credentials`: el token viaja en Authorization.
  app.enableCors({
    origin: listarOrigenes(config.get<string>('CORS_ORIGINS')),
    methods: ['GET', 'HEAD', 'POST', 'DELETE'],
    allowedHeaders: CABECERAS_PERMITIDAS,
    exposedHeaders: CABECERAS_EXPUESTAS,
    maxAge: 600,
  });

  // Antes del parser: también un 413 o un 415 de estas rutas sale con no-store
  app.use(sinCache(rutasSinCache));

  app.useBodyParser('json', { limit: LIMITE_CUERPO });
  // Después del parser: un cuerpo de más de 100 kB sigue siendo 413
  app.use(exigirJson);
}

/**
 * `Cache-Control: no-store` y `Pragma: no-cache` en toda respuesta (éxito o error) de las rutas
 * que empiezan con alguno de los prefijos: las suscripciones (llevan la URL del tercero) y la
 * API interna. Ningún proxy ni navegador debe guardarlas.
 */
export function sinCache(prefijos: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (prefijos.some((prefijo) => req.path.startsWith(prefijo))) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
    }
    next();
  };
}

const METODOS_CON_CUERPO = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Toda operación con cuerpo recibe `application/json` (con o sin charset). Otro tipo (texto,
 * XML, formulario, multipart) responde 415 en lugar de llegar vacío a la validación. Una
 * petición sin cuerpo no se mira.
 */
export function exigirJson(req: Request, _res: Response, next: NextFunction): void {
  const tieneCuerpo =
    Number(req.headers['content-length'] ?? 0) > 0 ||
    req.headers['transfer-encoding'] !== undefined;
  if (!METODOS_CON_CUERPO.has(req.method) || !tieneCuerpo) return next();
  const tipo = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (tipo === 'application/json') return next();
  next(new ErrorNegocio(415, CODIGO_SIN_EQUIVALENTE, 'Content-Type must be application/json'));
}
