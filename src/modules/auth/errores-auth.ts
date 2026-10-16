import { CODIGO_SIN_EQUIVALENTE } from '../../common/errores/codigo-error';
import { ErrorNegocio } from '../../common/errores/error-negocio';

/**
 * `realm` de la cabecera WWW-Authenticate (RFC 6750). El mismo del core: los tokens son los
 * mismos (mismo `aud`), y /flights/v1/webhooks responde igual que cuando lo atendía el core.
 */
export const REALM = 'quinde-vuelos-api';

/** Los códigos de error de RFC 6750 (sección 3.1) que usa el servicio. */
type ErrorBearer = 'invalid_token' | 'insufficient_scope';

/**
 * Valor de WWW-Authenticate. Sin `error` es la respuesta a una petición sin credenciales,
 * que según RFC 6750 no debe llevar código de error.
 */
export function desafioBearer(
  error?: ErrorBearer,
  descripcion?: string,
  scopes?: readonly string[],
): string {
  const partes = [`realm="${REALM}"`];
  if (error) partes.push(`error="${error}"`);
  if (descripcion) partes.push(`error_description="${descripcion}"`);
  if (scopes && scopes.length > 0) partes.push(`scope="${scopes.join(' ')}"`);
  return `Bearer ${partes.join(', ')}`;
}

/**
 * 401 como ProblemDetails. No hay un `code` para 401: va el de respaldo (CODIGO_SIN_EQUIVALENTE)
 * y el status dice qué pasó. Toda 401 lleva WWW-Authenticate.
 */
export function noAutenticado(detalle: string, desafio = desafioBearer()): ErrorNegocio {
  return new ErrorNegocio(401, CODIGO_SIN_EQUIVALENTE, detalle, {
    cabeceras: { 'WWW-Authenticate': desafio },
  });
}
