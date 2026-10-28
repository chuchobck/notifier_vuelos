import { EventoWebhook } from '../compartido/eventos-webhook';
import { WebhookDto } from './dto/webhook.dto';
import { SuscripcionVista } from './suscripcion.modelo';

/** Suscripción (español, adentro) → WebhookSubscription del contrato (inglés, afuera). */
export function aWebhook(suscripcion: SuscripcionVista): WebhookDto {
  return {
    id: suscripcion.id,
    url: suscripcion.url,
    // Una suscripción v1 solo escucha tipos del contrato 1.5 (su DTO no admite otros)
    events: suscripcion.eventos as EventoWebhook[],
    secret: suscripcion.secretoEnmascarado,
  };
}
