import { HttpException } from '@nestjs/common';
import { CodigoError, codigoPorStatus } from './codigo-error';
import { ErrorNegocio, ParametroInvalido } from './error-negocio';
import { traducirErrorBd } from './traducir-error-bd';
import { ProblemDetails, tipoDeCodigo, tituloDeStatus } from './problem-details';

const LARGO_MAXIMO_DETALLE = 500;
const RUTA_NO_ENCONTRADA = /^Cannot (GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) /;

/** Lo que el filtro necesita saber de la petición para traducir el error. */
export interface ContextoError {
  metodo: string;
  ruta: string;
  /** Métodos HTTP con los que sí existe esa ruta; sirve para distinguir 405 de 404. */
  metodosPermitidos: string[];
}

export interface RespuestaError {
  problema: ProblemDetails;
  cabeceras: Record<string, string>;
  /** true si es un fallo del servidor (5xx) y por tanto va al log con su stack. */
  esErrorInterno: boolean;
  /** Error original, solo para el log. */
  causa: unknown;
}

/**
 * Convierte cualquier cosa que se lance en el cuerpo ProblemDetails.
 * Es una función pura: el filtro global hace la entrada y salida.
 *
 * Los 5xx nunca llevan detalle interno, salvo el 503 que un controller lanza a propósito.
 */
export function traducirExcepcion(excepcion: unknown, contexto: ContextoError): RespuestaError {
  // Un error de Prisma o de un trigger pasa a ErrorNegocio; si no es de la base, queda igual.
  const negocio = excepcion instanceof ErrorNegocio ? excepcion : traducirErrorBd(excepcion);
  if (negocio) {
    return respuesta(
      {
        type: tipoDeCodigo(negocio.code),
        title: tituloDeStatus(negocio.status),
        status: negocio.status,
        detail: negocio.detalle,
        code: negocio.code,
        invalidParams: negocio.invalidParams,
      },
      negocio.causa ?? negocio,
      negocio.cabeceras,
    );
  }

  if (excepcion instanceof HttpException) {
    return traducirHttp(excepcion, contexto);
  }

  const delParser = errorDelParser(excepcion);
  if (delParser) {
    return { ...traducirHttp(delParser, contexto), causa: excepcion };
  }

  return respuesta(problemaGenerico(500), excepcion);
}

/**
 * Los errores de body-parser (cuerpo demasiado grande, encoding no soportado, JSON roto) son
 * `http-errors` de Express, no HttpException. Su `status` es 4xx y `expose` es true cuando el
 * mensaje se puede mostrar. Cualquier otro objeto con `status` no es de fiar: sigue siendo 500.
 */
function errorDelParser(excepcion: unknown): HttpException | undefined {
  if (typeof excepcion !== 'object' || excepcion === null) return undefined;
  const { status, expose, type } = excepcion as {
    status?: unknown;
    expose?: unknown;
    type?: unknown;
  };
  if (typeof status !== 'number' || status < 400 || status > 499 || expose !== true) {
    return undefined;
  }

  const mensajes: Record<string, string> = {
    'entity.too.large': 'Request body is too large',
    'entity.parse.failed': 'Malformed JSON body',
    'encoding.unsupported': 'Unsupported content encoding',
    'charset.unsupported': 'Unsupported charset',
  };
  const mensaje =
    typeof type === 'string' && mensajes[type] ? mensajes[type] : (excepcion as Error).message;
  return new HttpException(mensaje, status);
}

function traducirHttp(excepcion: HttpException, contexto: ContextoError): RespuestaError {
  const cuerpo = excepcion.getResponse();
  let status = excepcion.getStatus();
  const cabeceras: Record<string, string> = {};
  let detalle = textoDelMensaje(cuerpo);

  if (status === 404 && detalle !== undefined && RUTA_NO_ENCONTRADA.test(detalle)) {
    const permitidos = contexto.metodosPermitidos;
    if (permitidos.length > 0 && !metodoAdmitido(contexto.metodo, permitidos)) {
      status = 405;
      cabeceras['Allow'] = permitidos.join(', ');
      detalle = `Method ${contexto.metodo} is not allowed for this route; allowed: ${cabeceras['Allow']}`;
    } else {
      detalle = `Route not found: ${contexto.metodo} ${contexto.ruta}`;
    }
  }

  // Un cuerpo que ya trae los campos del ProblemDetails (type, title, code) se respeta.
  const propio = problemaPropio(cuerpo);
  const code = propio?.code ?? codigoPorStatus(status);

  const problema: ProblemDetails = {
    type: propio?.type ?? 'about:blank',
    title: propio?.title ?? tituloDeStatus(status),
    status,
    detail: detalleVisible(status, propio?.detail ?? detalle),
    code,
    invalidParams: propio?.invalidParams,
  };
  if (problema.type === 'about:blank' && propio === undefined && code !== codigoPorStatus(status)) {
    problema.type = tipoDeCodigo(code);
  }
  return respuesta(problema, excepcion, cabeceras);
}

/** El `detail` de un 5xx puede traer datos internos: solo se deja el del 503 de un controller. */
function detalleVisible(status: number, detalle: string | undefined): string | undefined {
  if (detalle === undefined || detalle === tituloDeStatus(status)) return undefined;
  if (status >= 500 && status !== 503) return undefined;
  if (status === 400 && /JSON/.test(detalle)) return 'Malformed JSON body';
  return detalle.length > LARGO_MAXIMO_DETALLE
    ? `${detalle.slice(0, LARGO_MAXIMO_DETALLE)}…`
    : detalle;
}

/** HEAD se atiende con la ruta GET. */
function metodoAdmitido(metodo: string, permitidos: string[]): boolean {
  return permitidos.includes(metodo) || (metodo === 'HEAD' && permitidos.includes('GET'));
}

function textoDelMensaje(cuerpo: string | object): string | undefined {
  if (typeof cuerpo === 'string') return cuerpo;
  const mensaje = (cuerpo as { message?: unknown }).message;
  if (Array.isArray(mensaje)) return mensaje.map(String).join('; ');
  return typeof mensaje === 'string' ? mensaje : undefined;
}

interface ProblemaPropio {
  type?: string;
  title?: string;
  detail?: string;
  code: CodigoError;
  invalidParams?: ParametroInvalido[];
}

function problemaPropio(cuerpo: string | object): ProblemaPropio | undefined {
  if (typeof cuerpo === 'string') return undefined;
  const candidato = cuerpo as Partial<Record<keyof ProblemaPropio, unknown>>;
  const codigos: string[] = Object.values(CodigoError);
  if (typeof candidato.code !== 'string' || !codigos.includes(candidato.code)) return undefined;

  return {
    type: typeof candidato.type === 'string' ? candidato.type : undefined,
    title: typeof candidato.title === 'string' ? candidato.title : undefined,
    detail: typeof candidato.detail === 'string' ? candidato.detail : undefined,
    code: candidato.code as CodigoError,
    invalidParams: Array.isArray(candidato.invalidParams)
      ? (candidato.invalidParams as ParametroInvalido[])
      : undefined,
  };
}

function problemaGenerico(status: number): ProblemDetails {
  return {
    type: 'about:blank',
    title: tituloDeStatus(status),
    status,
    code: codigoPorStatus(status),
  };
}

function respuesta(
  problema: ProblemDetails,
  causa: unknown,
  cabeceras: Record<string, string> = {},
): RespuestaError {
  // Se quitan las claves undefined para que el JSON solo lleve los campos del ProblemDetails.
  const limpio = Object.fromEntries(
    Object.entries(problema).filter(([, valor]) => valor !== undefined),
  ) as unknown as ProblemDetails;
  return { problema: limpio, cabeceras, esErrorInterno: problema.status >= 500, causa };
}
