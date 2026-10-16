/**
 * `code` de los ProblemDetails del servicio. Son códigos del core (components.schemas
 * ProblemDetails.code del contrato y AUTH_UNAVAILABLE, propio del core desde la fase 4b), para
 * que un cliente de /flights/v1/webhooks no note que la operación la atiende otro servicio.
 * No se agregan códigos propios: el `status` HTTP dice qué pasó.
 */
export enum CodigoError {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  /**
   * 503 cuando no hay claves del servicio de identidad con las que verificar el token (JWKS
   * caído y sin copia vigente). No es un 401: el cliente no hizo nada mal y debe reintentar.
   */
  AUTH_UNAVAILABLE = 'AUTH_UNAVAILABLE',
}

/**
 * El código de los errores que no tienen uno propio (400, 401, 403, 404, 405, 409, 413, 415,
 * 422, 5xx): el `status` HTTP dice qué pasó. Es el único lugar donde se decide.
 */
export const CODIGO_SIN_EQUIVALENTE = CodigoError.VALIDATION_FAILED;

/** Código que corresponde a un status cuando el error no trae uno propio. */
export function codigoPorStatus(status: number): CodigoError {
  return status === 429 ? CodigoError.RATE_LIMIT_EXCEEDED : CODIGO_SIN_EQUIVALENTE;
}
