import { CodigoError } from './codigo-error';
import { ErrorNegocio } from './error-negocio';

/**
 * Traduce los errores de Prisma 7 (adaptador de pg) y los de PostgreSQL al status y al `code`
 * de un ProblemDetails. Es el traductor del core (src/common/errores/traducir-error-bd.ts)
 * con solo las restricciones del esquema notificaciones.
 *
 * - La información útil no está en el `code` de Prisma sino en
 *   `meta.driverAdapterError.cause`: `originalCode` (SQLSTATE), `kind` y, a veces,
 *   `constraint.index`. Se decide por el SQLSTATE.
 * - Una base caída o saturada es 503 con `Retry-After`: el cliente puede reintentar.
 *
 * Los textos de `detail` van al cliente: en inglés y sin nombres de tablas ni de columnas.
 */

interface ErrorBd {
  prismaCode?: string;
  /** SQLSTATE de PostgreSQL (`originalCode`). */
  sqlstate?: string;
  /** `kind` que asigna el adaptador (UniqueConstraintViolation, RestrictViolation...). */
  tipo?: string;
  restriccion?: string;
  mensaje?: string;
}

interface Regla {
  status: number;
  code: CodigoError;
  detalle: string;
}

const regla = (status: number, code: CodigoError, detalle: string): Regla => ({
  status,
  code,
  detalle,
});

/** Restricciones con nombre propio del esquema que pueden saltar desde una petición. */
const POR_RESTRICCION: Record<string, Regla> = {
  // El mismo texto que el core para uq_webhook_cabecera_propietario_url
  uq_suscripcion_propietario_url: regla(
    409,
    CodigoError.VALIDATION_FAILED,
    'A webhook with this URL already exists',
  ),
};

const KINDS_BASE_NO_DISPONIBLE = new Set([
  'DatabaseNotReachable',
  'DatabaseDoesNotExist',
  'DatabaseAccessDenied',
  'ConnectionClosed',
  'TooManyConnections',
  'SocketTimeout',
  'TlsConnectionError',
]);
const CODIGOS_PRISMA_BASE_NO_DISPONIBLE = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

/** Códigos de Node/libc de un fallo de red al conectar con la base. */
const CODIGOS_DE_RED = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
/** Cuánto se baja por `cause`, `errors[]` y `meta.driverAdapterError` (corta ciclos). */
const PROFUNDIDAD_MAXIMA = 5;

/**
 * Devuelve el ErrorNegocio que corresponde a un error de base de datos, o `undefined` si el
 * error no es de la base o no está previsto (en ese caso el filtro responde 500).
 */
export function traducirErrorBd(error: unknown): ErrorNegocio | undefined {
  const bd = extraerErrorBd(error);
  const traducido =
    (bd === undefined ? undefined : clasificar(bd)) ??
    (hayFalloDeConexion(error) ? baseNoDisponible() : undefined);
  if (traducido === undefined) return undefined;

  const { status, code, detalle } = traducido.regla;
  return new ErrorNegocio(status, code, detalle, {
    cabeceras: traducido.cabeceras,
    causa: error,
  });
}

/** true si el error es de una base caída o saturada (para /health/ready y el filtro). */
export function esBaseNoDisponible(error: unknown): boolean {
  return traducirErrorBd(error)?.status === 503;
}

function clasificar(bd: ErrorBd): { regla: Regla; cabeceras?: Record<string, string> } | undefined {
  const { sqlstate, prismaCode, tipo } = bd;

  if (
    (tipo !== undefined && KINDS_BASE_NO_DISPONIBLE.has(tipo)) ||
    (prismaCode !== undefined && CODIGOS_PRISMA_BASE_NO_DISPONIBLE.has(prismaCode)) ||
    (sqlstate !== undefined && /^(08|53300|57P0[123])/.test(sqlstate))
  ) {
    return baseNoDisponible();
  }

  // Choque con otra transacción (escritura concurrente o deadlock): reintentar sirve.
  if (
    sqlstate === '40001' ||
    sqlstate === '40P01' ||
    prismaCode === 'P2034' ||
    tipo === 'TransactionWriteConflict' ||
    tipo === 'Deadlock'
  ) {
    return {
      regla: regla(
        409,
        CodigoError.VALIDATION_FAILED,
        'The operation conflicted with a concurrent change; retry',
      ),
      cabeceras: { 'Retry-After': '1' },
    };
  }

  if (sqlstate === '23505' || prismaCode === 'P2002') {
    return {
      regla:
        reglaPorRestriccion(bd) ??
        regla(
          409,
          CodigoError.VALIDATION_FAILED,
          'A record with the same unique value already exists',
        ),
    };
  }

  if (sqlstate === '23001' || sqlstate === '23503' || prismaCode === 'P2003') {
    return {
      regla: regla(422, CodigoError.VALIDATION_FAILED, 'A referenced record does not exist'),
    };
  }

  if (sqlstate === '23514') {
    return {
      regla:
        reglaPorRestriccion(bd) ??
        regla(422, CodigoError.VALIDATION_FAILED, 'The data violates a business rule'),
    };
  }

  if (sqlstate === '23502' || prismaCode === 'P2011') {
    return { regla: regla(400, CodigoError.VALIDATION_FAILED, 'A required value is missing') };
  }
  if ((sqlstate !== undefined && sqlstate.startsWith('22')) || prismaCode === 'P2023') {
    return { regla: regla(400, CodigoError.VALIDATION_FAILED, 'A value has an invalid format') };
  }

  return undefined;
}

function baseNoDisponible(): { regla: Regla; cabeceras: Record<string, string> } {
  return {
    regla: regla(503, CodigoError.VALIDATION_FAILED, 'The database is temporarily unavailable'),
    cabeceras: { 'Retry-After': '5' },
  };
}

/**
 * Si algún eslabón de la cadena de errores es un fallo de red al conectar. Con un nombre que
 * resuelve a varias direcciones (`localhost` es ::1 y 127.0.0.1) Node prueba todas y, si
 * ninguna responde, lanza un `AggregateError` que el adaptador no convierte en
 * DatabaseNotReachable (ver los Hallazgos de la fase 2 del core).
 */
function hayFalloDeConexion(error: unknown): boolean {
  const vistos = new Set<unknown>();
  const visitar = (nodo: unknown, profundidad: number): boolean => {
    if (typeof nodo !== 'object' || nodo === null || vistos.has(nodo)) return false;
    if (profundidad > PROFUNDIDAD_MAXIMA) return false;
    vistos.add(nodo);
    const e = nodo as {
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
      meta?: { driverAdapterError?: unknown };
    };
    if (typeof e.code === 'string' && CODIGOS_DE_RED.has(e.code)) return true;
    const hijos: unknown[] = [e.cause, e.meta?.driverAdapterError];
    if (Array.isArray(e.errors)) hijos.push(...e.errors);
    return hijos.some((hijo) => visitar(hijo, profundidad + 1));
  };
  return visitar(error, 0);
}

function reglaPorRestriccion(bd: ErrorBd): Regla | undefined {
  return bd.restriccion === undefined ? undefined : POR_RESTRICCION[bd.restriccion];
}

/** Lee lo que el adaptador de pg deja en el error de Prisma. */
function extraerErrorBd(error: unknown): ErrorBd | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { name?: unknown; code?: unknown; meta?: unknown; errorCode?: unknown };

  // Un fallo al conectar antes de la primera consulta.
  if (e.name === 'PrismaClientInitializationError') {
    return { prismaCode: typeof e.errorCode === 'string' ? e.errorCode : 'P1001' };
  }
  if (e.name !== 'PrismaClientKnownRequestError') return undefined;

  const causa = (e.meta as { driverAdapterError?: { cause?: Record<string, unknown> } } | undefined)
    ?.driverAdapterError?.cause;
  const mensaje = texto(causa?.originalMessage) ?? texto(causa?.message);
  const restriccionAdaptador = (causa?.constraint as { index?: unknown } | undefined)?.index;

  return {
    prismaCode: typeof e.code === 'string' ? e.code : undefined,
    sqlstate: texto(causa?.originalCode) ?? texto(causa?.code),
    tipo: texto(causa?.kind),
    restriccion: texto(restriccionAdaptador) ?? restriccionDelMensaje(mensaje),
    mensaje,
  };
}

/** `... violates check constraint "ck_x"` → `ck_x`. */
function restriccionDelMensaje(mensaje: string | undefined): string | undefined {
  return mensaje?.match(/constraint "([^"]+)"/)?.[1];
}

function texto(valor: unknown): string | undefined {
  return typeof valor === 'string' ? valor : undefined;
}
