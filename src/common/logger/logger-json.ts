import { LoggerService, LogLevel } from '@nestjs/common';
import { camposDeTraza } from '../../observabilidad/trazas';
import { obtenerContexto } from '../contexto/contexto-peticion';

/** Adónde va cada línea. Por defecto, la salida estándar; las pruebas pasan un arreglo. */
export type SalidaLog = (linea: string) => void;

const ORDEN: Record<LogLevel, number> = {
  verbose: 0,
  debug: 1,
  log: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

const escribirEnConsola: SalidaLog = (linea) => {
  process.stdout.write(`${linea}\n`);
};

/**
 * Logger de la app: una línea JSON por mensaje, con el X-Request-Id de la petición en curso y la
 * traza (traceId y spanId del span activo, o del SERVER de la petición), venga de donde venga (un
 * service, el filtro de errores, el log de acceso, el verificador de tokens):
 *
 *   {"time":"2026-10-15T12:00:00.000Z","level":"log","context":"HTTP","requestId":"8d1f...",
 *    "traceId":"4bf9...","spanId":"00f0...","message":"GET /flights/v1/webhooks 200 12.3ms"}
 *
 * No hay un filtro que borre datos sensibles de los mensajes: la regla es no ponerlos (ningún
 * token, secreto, firma, URL de un webhook ni cuerpo de un evento), y una prueba escanea los logs
 * de la suite para comprobarlo. Un filtro escondería el error en lugar de corregirlo.
 */
export class LoggerJson implements LoggerService {
  private nivelMinimo: number;

  constructor(
    private readonly salida: SalidaLog = escribirEnConsola,
    niveles: LogLevel[] = ['log', 'warn', 'error', 'fatal'],
  ) {
    this.nivelMinimo = minimo(niveles);
  }

  log(mensaje: unknown, ...parametros: unknown[]): void {
    this.escribir('log', mensaje, parametros);
  }

  error(mensaje: unknown, ...parametros: unknown[]): void {
    this.escribir('error', mensaje, parametros);
  }

  warn(mensaje: unknown, ...parametros: unknown[]): void {
    this.escribir('warn', mensaje, parametros);
  }

  debug(mensaje: unknown, ...parametros: unknown[]): void {
    this.escribir('debug', mensaje, parametros);
  }

  verbose(mensaje: unknown, ...parametros: unknown[]): void {
    this.escribir('verbose', mensaje, parametros);
  }

  fatal(mensaje: unknown, ...parametros: unknown[]): void {
    this.escribir('fatal', mensaje, parametros);
  }

  setLogLevels(niveles: LogLevel[]): void {
    this.nivelMinimo = minimo(niveles);
  }

  /**
   * Nest llama `log(mensaje, contexto)` y `error(mensaje, stack, contexto)`: el último texto es
   * el contexto (el nombre del Logger) y otro texto antes de él es el stack.
   */
  private escribir(nivel: LogLevel, mensaje: unknown, parametros: unknown[]): void {
    if (ORDEN[nivel] < this.nivelMinimo) return;
    const resto = [...parametros];
    const contexto =
      resto.length > 0 && typeof resto[resto.length - 1] === 'string'
        ? (resto.pop() as string)
        : undefined;
    const stack = resto.find((p): p is string => typeof p === 'string');

    const peticion = obtenerContexto();
    const activa = camposDeTraza();
    const traza = activa.traceId !== undefined ? activa : peticion?.traza;
    const linea: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: nivel,
      context: contexto,
      requestId: peticion?.requestId,
      traceId: traza?.traceId,
      spanId: traza?.spanId,
      message: comoTexto(mensaje),
      stack,
    };
    this.salida(JSON.stringify(linea));
  }
}

function minimo(niveles: LogLevel[]): number {
  if (niveles.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...niveles.map((nivel) => ORDEN[nivel]));
}

function comoTexto(mensaje: unknown): string {
  if (typeof mensaje === 'string') return mensaje;
  if (mensaje instanceof Error) return mensaje.message;
  try {
    return JSON.stringify(mensaje);
  } catch {
    return String(mensaje);
  }
}

/** Niveles por entorno: en producción sin debug ni verbose. */
export function nivelesPorEntorno(entorno: string | undefined): LogLevel[] {
  return entorno === 'production'
    ? ['log', 'warn', 'error', 'fatal']
    : ['debug', 'log', 'warn', 'error', 'fatal'];
}
