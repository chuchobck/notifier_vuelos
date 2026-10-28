import { EventoInterno } from './evento-interno';

/** Versión de la API que se anuncia en el WebhookPayload (info.version del contrato 1.5 sin el cuarto número). */
export const VERSION_API = '1.5.0';

/** components.schemas.WebhookPayload del contrato GDS Flight Core API 1.5.0.0. */
export interface WebhookPayload {
  eventId: string;
  eventType: string;
  occurredAt: string;
  apiVersion: string;
  data: Record<string, unknown>;
}

/**
 * Traductor v1: evento interno → WebhookPayload, el mismo cuerpo que armaba el core (y que este
 * servicio manda desde la fase 5a): occurredAt en UTC con milisegundos (toISOString) y
 * apiVersion 1.5.0. Ni el correlationId ni nada de v2 entra aquí: una suscripción v1 recibe los
 * mismos bytes que antes. Las claves van en este orden, y el cuerpo se congela al recibir el evento.
 */
export function aWebhookPayload(evento: EventoInterno): WebhookPayload {
  return {
    eventId: evento.eventId,
    eventType: evento.tipo,
    occurredAt: evento.ocurridoEn.toISOString(),
    apiVersion: VERSION_API,
    data: evento.data,
  };
}
