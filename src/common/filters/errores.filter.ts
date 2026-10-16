import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Request, Response } from 'express';
import { ejecutarEnContexto, obtenerContexto } from '../contexto/contexto-peticion';
import { contextoDeLaPeticion } from '../contexto/contexto.middleware';
import { ErrorNegocio } from '../errores/error-negocio';
import { CONTENT_TYPE_PROBLEMA } from '../errores/problem-details';
import { traducirExcepcion } from '../errores/traducir-excepcion';

/** Forma mínima de la capa de ruta de Express, que no tiene tipos públicos. */
interface CapaExpress {
  route?: { methods: Record<string, boolean> };
  match(ruta: string): boolean;
}

/**
 * Filtro global: todo error sale como `application/problem+json` (RFC 9457), sea de una
 * excepción de Nest, de una regla de negocio, de una ruta inexistente o de un fallo que nadie
 * previó. El stack de un 5xx queda en el log; al cliente nunca le llega.
 */
@Catch()
export class ErroresFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errores');

  constructor(private readonly adaptador: HttpAdapterHost) {}

  catch(excepcion: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw excepcion;

    const peticion = host.switchToHttp().getRequest<Request>();
    const respuesta = host.switchToHttp().getResponse<Response>();
    const ruta = peticion.originalUrl.split('?')[0].slice(0, 200);

    // Un error del parser del cuerpo llega antes de abrir el contexto asíncrono: el id se toma
    // de la petición para que su línea de log lo lleve igual.
    const contexto = contextoDeLaPeticion(peticion);
    const registrar = (escribir: () => void) =>
      contexto && obtenerContexto() === undefined
        ? ejecutarEnContexto(contexto, escribir)
        : escribir();

    const { problema, cabeceras, esErrorInterno, causa } = traducirExcepcion(excepcion, {
      metodo: peticion.method,
      ruta,
      metodosPermitidos: this.metodosDeLaRuta(ruta),
    });

    registrar(() => {
      if (esErrorInterno) {
        this.logger.error(
          `${peticion.method} ${ruta} → ${problema.status}`,
          describirParaLog(causa),
        );
      } else {
        const origen =
          causa instanceof Error && !(causa instanceof ErrorNegocio) ? ` (${resumir(causa)})` : '';
        this.logger.debug(
          `${peticion.method} ${ruta} → ${problema.status} ${problema.code}${origen}`,
        );
      }
    });

    if (respuesta.headersSent) {
      respuesta.end();
      return;
    }
    for (const [nombre, valor] of Object.entries(cabeceras)) respuesta.setHeader(nombre, valor);
    respuesta
      .status(problema.status)
      .setHeader('Content-Type', CONTENT_TYPE_PROBLEMA)
      .send(JSON.stringify(problema));
  }

  /** Métodos con los que existe la ruta pedida; vacío si la ruta no existe con ninguno. */
  private metodosDeLaRuta(ruta: string): string[] {
    // Express 4 guarda las rutas registradas en app._router.stack.
    const instancia = this.adaptador.httpAdapter.getInstance() as {
      _router?: { stack: CapaExpress[] };
    };
    const metodos = new Set<string>();
    for (const capa of instancia._router?.stack ?? []) {
      if (!capa.route || !capa.match(ruta)) continue;
      for (const [metodo, activo] of Object.entries(capa.route.methods)) {
        if (activo && metodo !== '_all') metodos.add(metodo.toUpperCase());
      }
    }
    return [...metodos];
  }
}

/** Los errores de Prisma traen la invocación y saltos de línea; al log, una línea sin datos. */
function resumir(error: Error): string {
  if (esDePrisma(error)) return `${error.name} ${codigoDe(error)}`.trim();
  return error.message.replace(/\s+/g, ' ').trim().slice(-300);
}

/**
 * El stack de un error interno, para el log. Un error de validación de Prisma copia en su
 * mensaje la invocación completa, con los valores (un secreto cifrado, una URL): de un error de Prisma
 * solo van el nombre, el código y las líneas "at ...".
 */
function describirParaLog(causa: unknown): string {
  if (!(causa instanceof Error)) return `Error no controlado: ${typeof causa}`;
  if (!esDePrisma(causa)) return causa.stack ?? causa.message;
  const lineas = (causa.stack ?? '').split('\n').filter((linea) => /^\s+at\s/.test(linea));
  return [`${causa.name} ${codigoDe(causa)}`.trim(), ...lineas].join('\n');
}

function esDePrisma(error: Error): boolean {
  return error.name.startsWith('PrismaClient');
}

function codigoDe(error: Error): string {
  const codigo = (error as { code?: unknown }).code;
  return typeof codigo === 'string' ? codigo : '';
}
