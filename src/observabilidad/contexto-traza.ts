import { Context, isSpanContextValid, ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { escribirTraceparent, leerTraceparent } from './traceparent';

/**
 * El `traceparent` del span activo (`00-<traceId>-<spanId>-<01|00>`), o null si no hay ninguno:
 * es lo que se guarda junto a un evento recibido (el span SERVER de POST /internal/v1/events, que
 * continúa la traza del relevo del core), para que cada entrega cuelgue de esa traza.
 */
export function traceparentActivo(): string | null {
  const contexto = trace.getActiveSpan()?.spanContext();
  if (!contexto || !isSpanContextValid(contexto)) return null;
  return escribirTraceparent(
    contexto.traceId,
    contexto.spanId,
    (contexto.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED,
  );
}

/**
 * El contexto de OpenTelemetry de un `traceparent` que el propio notifier guardó antes, para abrir
 * un span como su hijo. Es independiente de TRACE_TRUST_INCOMING (no viene de un cliente: es nuestro)
 * y respeta el bit de muestreo con que se guardó. Sin `traceparent` válido, un contexto vacío (la
 * traza empieza en el span que se abra).
 */
export function contextoDeTraceparent(traceparent: string | null | undefined): Context {
  const leido = leerTraceparent(traceparent ?? undefined);
  if (!leido) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: leido.traceId,
    spanId: leido.parentId,
    traceFlags: leido.muestreado ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  });
}
