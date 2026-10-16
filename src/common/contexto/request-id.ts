import { randomUUID } from 'node:crypto';

export const CABECERA_REQUEST_ID = 'X-Request-Id';

/**
 * Formato aceptado para un X-Request-Id que manda el cliente: de 8 a 64 caracteres, letras,
 * dígitos, punto, guion y guion bajo, empezando por letra o dígito (un UUID, un ULID o el id
 * de una traza). Lo demás podría falsear una línea de log (saltos de línea, espacios).
 */
const FORMATO_VALIDO = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;

export function esRequestIdValido(valor: unknown): valor is string {
  return typeof valor === 'string' && FORMATO_VALIDO.test(valor);
}

/**
 * El id de la petición: el del cliente si trae un formato válido; si falta o no es válido
 * (o llega repetido), uno nuevo. Nunca se rechaza la petición por esto.
 */
export function resolverRequestId(cabecera: string | string[] | undefined): string {
  return esRequestIdValido(cabecera) ? cabecera : randomUUID();
}
