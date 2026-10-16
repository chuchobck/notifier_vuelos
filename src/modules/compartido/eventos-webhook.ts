/**
 * Los 12 tipos de evento que el contrato deja suscribir (WebhookSubscription.events del contrato
 * GDS Flight Core API 1.5.0.0), en su orden. Es la misma lista de EVENTOS_WEBHOOK del core y de
 * fn_es_tipo_evento (db/esquema_notificaciones.sql), y hay un esquema por tipo en
 * contracts/events/: si una cambia, las demás cambian en el mismo paso.
 */
export const EVENTOS_WEBHOOK = [
  'booking.confirmed',
  'booking.failed',
  'booking.changed',
  'booking.cancelled',
  'booking.baggage_added',
  'hold.expired',
  'flight.schedule_changed',
  'flight.cancelled',
  'booking.ticket_issuing',
  'booking.ticket_issued',
  'booking.ticket_failed',
  'booking.checked_in',
] as const;

export type EventoWebhook = (typeof EVENTOS_WEBHOOK)[number];

export function esEventoWebhook(valor: unknown): valor is EventoWebhook {
  return (EVENTOS_WEBHOOK as readonly unknown[]).includes(valor);
}

/** Ordena como el contrato (el orden de EVENTOS_WEBHOOK). */
export const porOrdenDelContrato = (a: EventoWebhook, b: EventoWebhook): number =>
  EVENTOS_WEBHOOK.indexOf(a) - EVENTOS_WEBHOOK.indexOf(b);

/** `****` y los últimos 4 caracteres del secreto, como lo devuelve el core. */
export function enmascarar(secreto: string): string {
  return `****${secreto.slice(-4)}`;
}
