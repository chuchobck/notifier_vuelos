import { Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { plantillaDeRuta, SIN_PLANTILLA } from '../../observabilidad/plantilla-ruta';
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
 * El contexto de la petición, creado la primera vez que se pide (con su X-Request-Id y su línea de
 * acceso al terminar) y reusado después. Lo piden el middleware de observabilidad, que va primero
 * (necesita el request id para su span), y `middlewareRequestId`: un solo id por petición.
 *
 * La línea de acceso sigue el estándar de observabilidad: método, PLANTILLA de la ruta (nunca la
 * pedida: ni un id ni un `?token=` llegan al log), status, duración y, si es un cliente OAuth, su
 * client_id. Sin IP, sin el uuid de quien llama, sin cabeceras ni cuerpo.
 */
export function asegurarContexto(peticion: Request, respuesta: Response): ContextoPeticion {
  const existente = contextoDeLaPeticion(peticion);
  if (existente) return existente;
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
        `${peticion.method} ${plantillaDeRuta(peticion) ?? SIN_PLANTILLA} ${respuesta.statusCode} ` +
          `${ms.toFixed(1)}ms${contexto.cliente ? ` client=${contexto.cliente}` : ''}`,
      ),
    );
  });
  return contexto;
}

/**
 * Asigna el X-Request-Id (si el middleware de observabilidad no lo hizo ya) y lo devuelve en la
 * respuesta; como va antes que helmet, CORS y el parser del cuerpo, también lo llevan los errores
 * que esos producen (413, JSON roto).
 */
export function middlewareRequestId(peticion: Request, respuesta: Response, next: NextFunction) {
  asegurarContexto(peticion, respuesta);
  next();
}

/**
 * Abre el contexto asíncrono (AsyncLocalStorage) con el mismo objeto. Va DESPUÉS del parser del
 * cuerpo: los eventos de la petición que el parser escucha se emiten fuera del contexto y, si el
 * contexto se abriera antes, el parser lo perdería.
 */
export function middlewareContexto(peticion: Request, _respuesta: Response, next: NextFunction) {
  const contexto = contextoDeLaPeticion(peticion);
  if (contexto === undefined) return next();
  ejecutarEnContexto(contexto, next);
}
