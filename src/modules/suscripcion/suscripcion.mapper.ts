import { WebhookDto } from './dto/webhook.dto';
import { SuscripcionVista } from './suscripcion.modelo';

/** Suscripción (español, adentro) → WebhookSubscription del contrato (inglés, afuera). */
export function aWebhook(suscripcion: SuscripcionVista): WebhookDto {
  return {
    id: suscripcion.id,
    url: suscripcion.url,
    events: suscripcion.eventos,
    secret: suscripcion.secretoEnmascarado,
  };
}
