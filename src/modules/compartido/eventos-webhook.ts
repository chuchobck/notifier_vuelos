/**
 * Los 12 tipos de evento que el contrato GDS Flight Core API 1.5.0.0 deja suscribir
 * (WebhookSubscription.events), en su orden: los de /flights/v1/webhooks. Es la misma lista de
 * EVENTOS_WEBHOOK del core.
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

/**
 * Los 15 tipos del contrato de Vuelos v2 (VuelosEventName), en su orden: los 12 de v1 más
 * hold.created, booking.seat_changed y flight.status_changed. Son los de /api/v2/vuelos/webhooks y
 * los que el core puede publicar. Es la misma lista de fn_es_tipo_evento
 * (db/esquema_notificaciones.sql) y hay un esquema por tipo en contracts/events/: si una cambia,
 * las demás cambian en el mismo paso.
 */
export const EVENTOS = [
  'hold.created',
  'hold.expired',
  'booking.confirmed',
  'booking.failed',
  'booking.changed',
  'booking.cancelled',
  'booking.baggage_added',
  'booking.seat_changed',
  'booking.ticket_issuing',
  'booking.ticket_issued',
  'booking.ticket_failed',
  'booking.checked_in',
  'flight.status_changed',
  'flight.schedule_changed',
  'flight.cancelled',
] as const;

/** Un tipo del contrato 1.5 (lo que acepta /flights/v1/webhooks). */
export type EventoWebhook = (typeof EVENTOS_WEBHOOK)[number];

/** Un tipo del contrato v2 (cualquiera de los 15). */
export type TipoEvento = (typeof EVENTOS)[number];

export function esEventoWebhook(valor: unknown): valor is EventoWebhook {
  return (EVENTOS_WEBHOOK as readonly unknown[]).includes(valor);
}

export function esTipoEvento(valor: unknown): valor is TipoEvento {
  return (EVENTOS as readonly unknown[]).includes(valor);
}

/** Ordena como el contrato 1.5 (el orden de EVENTOS_WEBHOOK). */
export const porOrdenDelContrato = (a: EventoWebhook, b: EventoWebhook): number =>
  EVENTOS_WEBHOOK.indexOf(a) - EVENTOS_WEBHOOK.indexOf(b);

/** Ordena como el contrato v2 (el orden de VuelosEventName). */
export const porOrdenV2 = (a: TipoEvento, b: TipoEvento): number =>
  EVENTOS.indexOf(a) - EVENTOS.indexOf(b);

/**
 * Los tipos guardados de una suscripción, en el orden del contrato de su formato (la base no
 * garantiza un orden): el de 1.5 en una v1, el de VuelosEventName en una v2.
 */
export function enOrdenDelFormato(tipos: readonly string[], formato: 'v1' | 'v2'): TipoEvento[] {
  const orden: readonly TipoEvento[] = formato === 'v2' ? EVENTOS : EVENTOS_WEBHOOK;
  return orden.filter((tipo) => tipos.includes(tipo));
}

/** `****` y los últimos 4 caracteres del secreto, como lo devuelve el core. */
export function enmascarar(secreto: string): string {
  return `****${secreto.slice(-4)}`;
}
