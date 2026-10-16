import { CodigoError } from './codigo-error';

/** Un campo que la petición trajo mal: `invalidParams` del esquema ProblemDetails. */
export interface ParametroInvalido {
  name: string;
  reason: string;
}

export interface OpcionesErrorNegocio {
  invalidParams?: ParametroInvalido[];
  /** Cabeceras de la respuesta de error (por ejemplo `Retry-After` en un 409). */
  cabeceras?: Record<string, string>;
  /** Error original, solo para el log: nunca llega al cliente. */
  causa?: unknown;
}

/**
 * Error de regla de negocio: el service lo lanza con el status HTTP y el `code` que
 * corresponden. El filtro global lo convierte en `application/problem+json`.
 *
 * `detalle` llega al cliente (campo `detail`), así que va en inglés y sin datos internos.
 *
 *   throw new ErrorNegocio(409, CodigoError.VALIDATION_FAILED, 'An account with this email already exists');
 */
export class ErrorNegocio extends Error {
  readonly invalidParams?: ParametroInvalido[];
  readonly cabeceras?: Record<string, string>;
  readonly causa?: unknown;

  constructor(
    readonly status: number,
    readonly code: CodigoError,
    detalle?: string,
    opciones: OpcionesErrorNegocio = {},
  ) {
    super(detalle ?? code);
    this.name = 'ErrorNegocio';
    this.invalidParams = opciones.invalidParams;
    this.cabeceras = opciones.cabeceras;
    this.causa = opciones.causa;
  }

  /** Texto para `detail`; si no se dio uno, el campo se omite. */
  get detalle(): string | undefined {
    return this.message === this.code ? undefined : this.message;
  }
}
