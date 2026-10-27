import { Counter, Histogram, Registry } from 'prom-client';
import { CUBETAS_DURACION } from './metricas';

/** Cómo terminó un intento de entrega: lista cerrada (la etiqueta `result`). */
export type ResultadoEntregaMetrica = 'delivered' | 'retry' | 'failed';

/** Formato de la entrega: el WebhookPayload v1 o el CloudEvent v2 (la etiqueta `format`). */
export type FormatoMetrica = 'v1' | 'v2';

/** Cómo terminó una publicación del core: `accepted` (202) o `duplicate` (200). */
export type ResultadoPublicacionMetrica = 'accepted' | 'duplicate';

/**
 * Las métricas propias del notifier (`notifier_*`), con la regla de cardinalidad del estándar:
 * etiquetas de listas cerradas. Nunca el id de una suscripción, su URL, el dueño, el tipo de evento
 * ni el código HTTP del tercero (lo decide el tercero: no es una lista cerrada).
 *
 * - `notifier_deliveries_total{result, format}`: intentos de entrega por resultado.
 * - `notifier_delivery_duration_seconds{format}`: lo que tardó cada POST al tercero.
 * - `notifier_events_received_total{result}`: publicaciones del core aceptadas o repetidas.
 *
 * Los gauges de la bandeja (`notifier_deliveries_pending`, `notifier_deliveries_oldest_pending_seconds`)
 * se leen de la base al raspar: están en src/modules/entrega/metricas-entregas.ts.
 */
export class MetricasNotifier {
  readonly entregas: Counter<'result' | 'format'>;
  readonly duracionEntrega: Histogram<'format'>;
  readonly eventosRecibidos: Counter<'result'>;

  constructor(registro: Registry) {
    this.entregas = new Counter({
      name: 'notifier_deliveries_total',
      help: 'Intentos de entrega a terceros, por resultado (delivered, retry, failed) y formato (v1, v2)',
      labelNames: ['result', 'format'] as const,
      registers: [registro],
    });
    this.duracionEntrega = new Histogram({
      name: 'notifier_delivery_duration_seconds',
      help: 'Duración del POST de una entrega al tercero, por formato (v1, v2)',
      labelNames: ['format'] as const,
      buckets: CUBETAS_DURACION,
      registers: [registro],
    });
    this.eventosRecibidos = new Counter({
      name: 'notifier_events_received_total',
      help: 'Eventos publicados por el core: accepted (202) o duplicate (200, ya estaba)',
      labelNames: ['result'] as const,
      registers: [registro],
    });
  }

  entrega(resultado: ResultadoEntregaMetrica, formato: FormatoMetrica): void {
    this.entregas.inc({ result: resultado, format: formato });
  }
}
