import { ValidationError, ValidationPipe } from '@nestjs/common';
import { CodigoError } from '../errores/codigo-error';
import { ErrorNegocio, ParametroInvalido } from '../errores/error-negocio';

const LARGO_MAXIMO_DETALLE = 500;

/**
 * ValidationPipe global: rechaza campos que el DTO no declara (`whitelist` y
 * `forbidNonWhitelisted`) y convierte el cuerpo al tipo del DTO (`transform`).
 * Un rechazo sale como 400 VALIDATION_FAILED con el detalle de cada campo.
 */
export function crearPipeValidacion(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errores) => errorDeValidacion(errores),
  });
}

/** Un ErrorNegocio 400 con un `invalidParams` por cada regla incumplida. */
export function errorDeValidacion(errores: ValidationError[]): ErrorNegocio {
  const invalidParams = aplanar(errores);
  const resumen = invalidParams.map(({ name, reason }) => `${name}: ${reason}`).join('; ');
  const detalle =
    resumen.length > LARGO_MAXIMO_DETALLE ? `${resumen.slice(0, LARGO_MAXIMO_DETALLE)}…` : resumen;

  return new ErrorNegocio(400, CodigoError.VALIDATION_FAILED, detalle, { invalidParams });
}

/** Recorre los errores anidados y arma nombres como `passengers[0].firstName`. */
function aplanar(errores: ValidationError[], prefijo = ''): ParametroInvalido[] {
  return errores.flatMap((error) => {
    const nombre = unirRuta(prefijo, error.property);
    const propios = Object.values(error.constraints ?? {}).map((reason) => ({
      name: nombre,
      reason,
    }));
    return [...propios, ...aplanar(error.children ?? [], nombre)];
  });
}

/** Las posiciones de un arreglo llegan como propiedad "0": se escriben `[0]`. */
function unirRuta(prefijo: string, propiedad: string): string {
  if (/^\d+$/.test(propiedad)) return `${prefijo}[${propiedad}]`;
  return prefijo === '' ? propiedad : `${prefijo}.${propiedad}`;
}
