import { Context, SpanKind, trace } from '@opentelemetry/api';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { asegurarContexto } from '../common/contexto/contexto.middleware';
import { metodoNormalizado } from './atributos';
import { Observabilidad } from './observabilidad';
import { plantillaDeRuta, SIN_PLANTILLA } from './plantilla-ruta';
import { CLAVE_REQUEST_ID, marcarError } from './trazas';

/**
 * El equivalente de `fastify.ts` del gateway para Express (docs/OBSERVABILIDAD.md, sección 5):
 * abre el span SERVER de cada petición REST, lo deja activo, pone X-Trace-Id en la respuesta y, al
 * terminar, lo nombra con la PLANTILLA de la ruta, lo cierra y registra las métricas del servidor.
 *
 * Son dos middlewares porque el parser del cuerpo emite sus eventos fuera del contexto asíncrono
 * (igual que pasa con el contexto de la petición, ver configurar-app.ts): el primero crea el span
 * y entra en su contexto, para que hasta un 413 del parser quede en la traza; el segundo, ya
 * pasado el parser, vuelve a entrar para que el controlador y todo lo que llama lo vean activo.
 */

interface Observacion {
  contexto: Context;
}

const OBSERVACION = Symbol('observacionPeticion');
type PeticionObservada = Request & { [OBSERVACION]?: Observacion };

/** Primer middleware de la app: el span SERVER y la métrica del servidor. */
export function middlewareObservabilidad(obs: Observabilidad): RequestHandler {
  const { trazas, metricas } = obs;
  return (peticion: Request, respuesta: Response, next: NextFunction) => {
    const contextoPeticion = asegurarContexto(peticion, respuesta);
    const metodo = metodoNormalizado(peticion.method);
    const padre = trazas.contextoEntrante(peticion.headers.traceparent);
    // El nombre definitivo ("METHOD /plantilla") se pone al terminar, cuando se conoce la plantilla
    const span = trazas.iniciar(
      metodo,
      SpanKind.SERVER,
      { 'http.request.method': metodo, 'quinde.request_id': contextoPeticion.requestId },
      padre,
    );
    const { traceId, spanId } = span.spanContext();
    contextoPeticion.traza = { traceId, spanId };
    respuesta.setHeader('X-Trace-Id', traceId);
    const contexto = trace
      .setSpan(padre, span)
      .setValue(CLAVE_REQUEST_ID, contextoPeticion.requestId);
    (peticion as PeticionObservada)[OBSERVACION] = { contexto };

    const inicio = process.hrtime.bigint();
    let terminada = false;
    const terminar = () => {
      if (terminada) return;
      terminada = true;
      const ruta = plantillaDeRuta(peticion);
      const status = respuesta.statusCode;
      span.updateName(`${metodo} ${ruta ?? SIN_PLANTILLA}`);
      span.setAttributes({
        'http.route': ruta ?? SIN_PLANTILLA,
        'http.response.status_code': status,
      });
      // En un span de servidor, solo un 5xx es error (un 4xx es culpa del cliente)
      if (status >= 500) marcarError(span, String(status));
      span.end();
      metricas.registrarServidor(
        metodo,
        ruta,
        status,
        Number(process.hrtime.bigint() - inicio) / 1e9,
      );
    };
    // 'finish': la respuesta salió; 'close' sin 'finish': el cliente colgó a medias
    respuesta.on('finish', terminar);
    respuesta.on('close', terminar);

    trazas.enContexto(contexto, next);
  };
}

/** Segundo middleware (después del parser del cuerpo): vuelve a dejar activo el contexto de la traza. */
export function middlewareContextoTraza(obs: Observabilidad): RequestHandler {
  return (peticion: Request, _respuesta: Response, next: NextFunction) => {
    const observacion = (peticion as PeticionObservada)[OBSERVACION];
    if (observacion === undefined) return next();
    obs.trazas.enContexto(observacion.contexto, next);
  };
}
