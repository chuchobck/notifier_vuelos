import { Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { ContextoPeticion, ejecutarEnContexto, normalizarIp } from './contexto-peticion';
import { CABECERA_REQUEST_ID, resolverRequestId } from './request-id';

const logger = new Logger('HTTP');

/** Donde se guarda el contexto en la petición, para quien corre fuera del contexto asíncrono. */
const CONTEXTO_EN_PETICION = Symbol('contextoPeticion');

type PeticionConContexto = Request & { [CONTEXTO_EN_PETICION]?: ContextoPeticion };

/** El contexto que se le asignó a la petición, aunque se lea fuera de `ejecutarEnContexto`. */
export function contextoDeLaPeticion(peticion: Request): ContextoPeticion | undefined {
  return (peticion as PeticionConContexto)[CONTEXTO_EN_PETICION];
}

/**
 * Primer middleware de la app. Asigna el X-Request-Id y lo devuelve en la respuesta; como va
 * antes que helmet, CORS y el parser del cuerpo, también lo llevan los errores que esos
 * producen (413, JSON roto). Al terminar la respuesta deja una línea de log de acceso.
 *
 * La línea de acceso lleva método, ruta SIN la query (un `?token=` no llega al log), status,
 * duración, IP, el uuid de quien llama y, si es un cliente OAuth, su client_id. Nunca cabeceras
 * ni cuerpo: ahí viajan los tokens, los secretos de los webhooks y sus URL.
 */
export function middlewareRequestId(peticion: Request, respuesta: Response, next: NextFunction) {
  const contexto: ContextoPeticion = {
    requestId: resolverRequestId(peticion.headers['x-request-id']),
    ip: normalizarIp(peticion.ip),
    usuario: null,
  };
  (peticion as PeticionConContexto)[CONTEXTO_EN_PETICION] = contexto;
  respuesta.setHeader(CABECERA_REQUEST_ID, contexto.requestId);

  const inicio = process.hrtime.bigint();
  respuesta.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    // 'finish' se emite desde el socket, fuera del contexto asíncrono de la petición:
    // se vuelve a entrar para que el logger vea el id.
    ejecutarEnContexto(contexto, () =>
      logger.log(
        `${peticion.method} ${peticion.originalUrl.split('?')[0]} ${respuesta.statusCode} ` +
          `${ms.toFixed(1)}ms ip=${contexto.ip ?? '-'}` +
          `${contexto.usuario ? ` sub=${contexto.usuario}` : ''}` +
          `${contexto.cliente ? ` client=${contexto.cliente}` : ''}`,
      ),
    );
  });
  next();
}

/**
 * Segundo middleware: abre el contexto asíncrono (AsyncLocalStorage) con el mismo objeto.
 * Va DESPUÉS del parser del cuerpo: los eventos de la petición que el parser escucha se
 * emiten fuera del contexto y, si el contexto se abriera antes, el parser lo perdería.
 */
export function middlewareContexto(peticion: Request, _respuesta: Response, next: NextFunction) {
  const contexto = contextoDeLaPeticion(peticion);
  if (contexto === undefined) return next();
  ejecutarEnContexto(contexto, next);
}
