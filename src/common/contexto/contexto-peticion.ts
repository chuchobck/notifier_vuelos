import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Lo que cualquier capa necesita saber de la petición en curso sin recibirlo como parámetro:
 * el logger lo imprime y la auditoría de suscripciones lo guarda.
 */
export interface ContextoPeticion {
  /** X-Request-Id: el que mandó el cliente si tenía un formato válido, o uno generado. */
  requestId: string;
  /**
   * X-Correlation-Id (contrato v2, §6): el proceso de negocio completo. El que llegó, sin cambios,
   * si tiene formato válido; si no, `corr-<uuid>`. Vuelve en cada respuesta y va en cada log.
   */
  correlationId: string;
  /** IP del cliente (con `trust proxy` configurado, la de X-Forwarded-For). */
  ip: string | null;
  /**
   * `sub` del JWT, que JwtAuthGuard llena con `fijarUsuario`; null en una ruta pública.
   * Es el `id_propietario` de las suscripciones.
   */
  usuario: string | null;
  /**
   * `client_id` del token, solo si es de un cliente máquina a máquina (client_credentials
   * de identity_vuelos). Ese `sub` es el id del cliente en el servicio de identidad, así que la
   * auditoría ya lo identifica; esto es su código legible, que va a la línea de acceso.
   */
  cliente?: string;
  /**
   * El span SERVER de la petición (lo pone el middleware de observabilidad), para las líneas que se
   * escriben fuera del contexto de OpenTelemetry (la de acceso, al terminar la respuesta).
   */
  traza?: { traceId: string; spanId: string };
}

const almacen = new AsyncLocalStorage<ContextoPeticion>();

/** El contexto de la petición en curso, o `undefined` fuera de una petición (arranque, tareas). */
export function obtenerContexto(): ContextoPeticion | undefined {
  return almacen.getStore();
}

/** Corre `trabajo` con `contexto` visible desde `obtenerContexto()`, también tras cada `await`. */
export function ejecutarEnContexto<T>(contexto: ContextoPeticion, trabajo: () => T): T {
  return almacen.run(contexto, trabajo);
}

/**
 * Registra el usuario autenticado en el contexto. Lo llama JwtAuthGuard con el `sub` del
 * token y, si lo trae, su `client_id`; la auditoría guarda el `sub` como actor.
 */
export function fijarUsuario(usuario: string, cliente?: string): void {
  const contexto = almacen.getStore();
  if (!contexto) return;
  contexto.usuario = usuario;
  if (cliente !== undefined) contexto.cliente = cliente;
}

/** `::ffff:203.0.113.7` (IPv4 dentro de IPv6) → `203.0.113.7`; lo demás queda igual. */
export function normalizarIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return ip.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, '$1');
}
