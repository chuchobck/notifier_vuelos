import { SuscripcionVista } from '../suscripcion.modelo';
import { WebhookV2Dto } from './dto/webhook.v2.dto';

/** Suscripción (español, adentro) → WebhookSubscription del contrato v2 (inglés, afuera). */
export function aWebhookV2(suscripcion: SuscripcionVista): WebhookV2Dto {
  return {
    id: suscripcion.id,
    url: suscripcion.url,
    events: suscripcion.eventos,
    secret: suscripcion.secretoEnmascarado,
    // Solo se listan y se crean activas: una dada de baja ya no aparece
    active: true,
    createdAt: suscripcion.fechaCreacion.toISOString(),
  };
}
