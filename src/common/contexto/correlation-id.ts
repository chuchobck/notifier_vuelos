import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { obtenerContexto } from './contexto-peticion';

/** La cabecera del proceso de negocio completo (contrato v2, §6). También en v1. */
export const CABECERA_CORRELACION = 'X-Correlation-Id';

/**
 * Formato aceptado para un X-Correlation-Id: de 1 a 100 caracteres (el maxLength del contrato),
 * letras, dígitos, punto, guion, guion bajo y dos puntos. Es el mismo del core: lo demás podría
 * falsear una línea de log (saltos de línea, espacios) o una cabecera de salida.
 */
export const FORMATO_CORRELACION = /^[A-Za-z0-9._:-]{1,100}$/;

export function esCorrelationIdValido(valor: unknown): valor is string {
  return typeof valor === 'string' && FORMATO_CORRELACION.test(valor);
}

/** Uno nuevo, con la forma del core: `corr-<uuid>`. */
export function nuevoCorrelationId(): string {
  return `corr-${randomUUID()}`;
}

/**
 * El id del proceso: el que llegó, SIN CAMBIOS, si tiene un formato válido; si falta, no es
 * válido o llega repetido, uno nuevo. Nunca se rechaza la petición por esto.
 */
export function resolverCorrelationId(valor: string | string[] | undefined): string {
  return esCorrelationIdValido(valor) ? valor : nuevoCorrelationId();
}

/** El de un trabajo fuera de una petición (una entrega del proceso periódico). */
const almacenTrabajo = new AsyncLocalStorage<string>();

/** Corre `trabajo` con `correlationId` visible desde `correlacionActual()` (y en cada log). */
export function conCorrelacion<T>(correlationId: string, trabajo: () => T): T {
  return almacenTrabajo.run(correlationId, trabajo);
}

/** El de la petición en curso o el del trabajo en curso; `undefined` fuera de los dos. */
export function correlacionActual(): string | undefined {
  return obtenerContexto()?.correlationId ?? almacenTrabajo.getStore();
}
