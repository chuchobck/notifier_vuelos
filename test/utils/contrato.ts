import Ajv from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Los esquemas del contrato GDS Flight Core API 1.5.0.0 (contracts/vuelos-openapi.yaml del core)
 * que tocan a este servicio, copiados tal cual: components.schemas.WebhookSubscription y
 * WebhookPayload. Las pruebas validan con ellos lo que responde /flights/v1/webhooks y lo que
 * recibe el tercero, como las pruebas de contrato del core.
 */
const EVENTOS = [
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
];

export const WEBHOOK_SUBSCRIPTION = {
  type: 'object',
  required: ['url', 'events', 'secret'],
  properties: {
    id: { type: 'string', format: 'uuid', readOnly: true },
    url: { type: 'string', format: 'uri' },
    events: { type: 'array', items: { type: 'string', enum: EVENTOS } },
    secret: { type: 'string' },
  },
};

export const WEBHOOK_PAYLOAD = {
  type: 'object',
  properties: {
    eventId: { type: 'string' },
    eventType: { type: 'string' },
    occurredAt: { type: 'string', format: 'date-time' },
    apiVersion: { type: 'string' },
    data: {
      type: 'object',
      properties: {
        bookingId: { type: 'string' },
        pnr: { type: 'string' },
        status: { type: 'string' },
        refundAmount: { type: 'string' },
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validarSuscripcion = ajv.compile(WEBHOOK_SUBSCRIPTION);
const validarPayload = ajv.compile(WEBHOOK_PAYLOAD);

/** Falla la prueba si el cuerpo no cumple WebhookSubscription del contrato. */
export function esperarWebhookSubscription(cuerpo: unknown): void {
  const valido = validarSuscripcion(cuerpo);
  expect(validarSuscripcion.errors ?? []).toEqual([]);
  expect(valido).toBe(true);
}

/** Falla la prueba si el cuerpo no cumple WebhookPayload del contrato. */
export function esperarWebhookPayload(cuerpo: unknown): void {
  const valido = validarPayload(cuerpo);
  expect(validarPayload.errors ?? []).toEqual([]);
  expect(valido).toBe(true);
}
