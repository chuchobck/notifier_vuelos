import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CODIGO_AEROLINEA_POR_DEFECTO } from '../../../config/eventos';
import { CloudEvent, TraductorCloudEvents } from './cloudevent.v2';
import { EventoInterno, FormatoEntrega } from './evento-interno';
import { aWebhookPayload, WebhookPayload } from './webhook-payload.v1';

/**
 * El único lugar que decide qué cuerpo recibe cada formato de suscripción: el WebhookPayload del
 * contrato 1.5 (v1, sin cambios) o el CloudEvent del contrato v2. Lo usan el reparto (al recibir
 * el evento, una vez por formato) y el feed.
 */
@Injectable()
export class Traductores {
  readonly cloudEvents: TraductorCloudEvents;

  constructor(config: ConfigService) {
    this.cloudEvents = new TraductorCloudEvents(
      config.get<string>('AIRLINE_CODE') || CODIGO_AEROLINEA_POR_DEFECTO,
    );
  }

  /** El WebhookPayload del contrato 1.5 (suscripciones v1), sin cambios respecto de la fase 5a. */
  v1(evento: EventoInterno): WebhookPayload {
    return aWebhookPayload(evento);
  }

  /** El CloudEvent del contrato v2 (suscripciones v2 y el feed). */
  v2(evento: EventoInterno): CloudEvent {
    return this.cloudEvents.traducir(evento);
  }

  cuerpoPara(formato: FormatoEntrega, evento: EventoInterno): WebhookPayload | CloudEvent {
    return formato === 'v2' ? this.v2(evento) : this.v1(evento);
  }
}
