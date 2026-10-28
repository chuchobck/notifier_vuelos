import { TipoEvento } from '../../compartido/eventos-webhook';

/**
 * Un evento tal como lo guarda el notifier (la fila de `evento`), independiente de quién lo
 * recibe: es la entrada de los traductores (patrón Message Translator). Cada formato de salida
 * (el WebhookPayload v1, el CloudEvent v2) se arma desde aquí y solo desde aquí.
 */
export interface EventoInterno {
  eventId: string;
  tipo: TipoEvento;
  /** occurredAt del sobre: cuándo pasó el hecho en el core. */
  ocurridoEn: Date;
  /** X-Correlation-Id del proceso que originó el hecho (nunca vacío). */
  correlationId: string;
  /** El `data` del sobre, tal como lo validó el esquema de su tipo. */
  data: Record<string, unknown>;
}

/** El formato de entrega de una suscripción: el de la API por la que se creó. */
export type FormatoEntrega = 'v1' | 'v2';
