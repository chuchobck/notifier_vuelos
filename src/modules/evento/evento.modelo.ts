import { SobreEvento } from './contrato/registro-esquemas';

/** Versión de la API que se anuncia en el WebhookPayload (info.version del contrato del core sin el cuarto número). */
export const VERSION_API = '1.5.0';

/** components.schemas.WebhookPayload del contrato: lo que recibe el tercero. */
export interface WebhookPayload {
  eventId: string;
  eventType: string;
  occurredAt: string;
  apiVersion: string;
  data: Record<string, unknown>;
}

export interface ResultadoPublicacion {
  eventId: string;
  /** Entregas que tiene el evento (una por suscripción activa del dueño que escucha el tipo). */
  entregas: number;
  /** El eventId ya estaba guardado con el mismo contenido: no se hizo nada. */
  duplicado: boolean;
}

export type { SobreEvento };
