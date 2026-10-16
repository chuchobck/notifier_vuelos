import { EventoAceptadoDto } from './dto/evento.dto';
import { ResultadoPublicacion, SobreEvento, VERSION_API, WebhookPayload } from './evento.modelo';

/**
 * El sobre del core → el WebhookPayload del contrato, el mismo cuerpo que armaba el core:
 * occurredAt en UTC con milisegundos (toISOString, como el to_char del core) y apiVersion 1.5.0.
 * Se congela al recibir el evento: cada reintento envía exactamente este cuerpo.
 */
export function aWebhookPayload(sobre: SobreEvento): WebhookPayload {
  return {
    eventId: sobre.eventId,
    eventType: sobre.eventType,
    occurredAt: new Date(sobre.occurredAt).toISOString(),
    apiVersion: VERSION_API,
    data: sobre.data,
  };
}

export function aEventoAceptado(resultado: ResultadoPublicacion): EventoAceptadoDto {
  return {
    eventId: resultado.eventId,
    deliveries: resultado.entregas,
    duplicate: resultado.duplicado,
  };
}
