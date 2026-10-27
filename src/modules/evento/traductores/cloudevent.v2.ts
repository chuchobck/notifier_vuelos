import { TipoEvento } from '../../compartido/eventos-webhook';
import { EventoInterno } from './evento-interno';

/** Prefijo del `type` (contrato v2, §8): `ec.edu.epn.booking.vuelos.<evento>`. */
export const PREFIJO_TIPO_CLOUDEVENT = 'ec.edu.epn.booking.vuelos.';

/** `Content-Type` de una entrega v2: CloudEvents en modo estructurado (JSON). */
export const CONTENT_TYPE_CLOUDEVENTS = 'application/cloudevents+json';

/** VuelosCloudEvent del contrato v2 (CloudEventBase y el `data` de su tipo). */
export interface CloudEvent {
  specversion: '1.0';
  type: string;
  source: string;
  id: string;
  time: string;
  subject: string;
  datacontenttype: 'application/json';
  correlationid: string;
  data: Record<string, unknown>;
}

/** `/aerolineas/<AIRLINE_CODE>/vuelos` (contrato v2, §8). */
export function sourceDe(codigoAerolinea: string): string {
  return `/aerolineas/${codigoAerolinea}/vuelos`;
}

/**
 * El recurso afectado (`subject`): el holdId en hold.*, `<flightNumber>/<date>` en
 * flight.status_changed y el bookingId en lo demás (los booking.* y los flight.* de v1, que son
 * uno por reserva). Son ids públicos del contrato: nunca un nombre ni un documento.
 */
export function subjectDe(tipo: TipoEvento, data: Record<string, unknown>): string {
  if (tipo.startsWith('hold.')) return String(data.holdId);
  if (tipo === 'flight.status_changed') return `${String(data.flightNumber)}/${String(data.date)}`;
  return String(data.bookingId);
}

/**
 * Traductor v2 (patrón Message Translator): evento interno → CloudEvent 1.0 en modo estructurado.
 *
 * - `type` = `ec.edu.epn.booking.vuelos.<eventType>`, `source` = `/aerolineas/<AIRLINE_CODE>/vuelos`.
 * - `id` = el eventId (el mismo en cada reintento, en cada suscripción y en el feed: deduplicar).
 * - `time` = occurredAt en UTC con milisegundos; `datacontenttype` = application/json.
 * - `correlationid` (extensión) = el X-Correlation-Id del proceso que originó el hecho.
 * - `data` = el data del sobre tal cual (ya validado contra su esquema, sin campos de más).
 *
 * Lo usan el reparto (el cuerpo de cada entrega v2, congelado) y el feed GET /api/v2/vuelos/eventos:
 * el mismo evento se ve igual por los dos caminos. Las claves van en este orden.
 */
export class TraductorCloudEvents {
  private readonly source: string;

  constructor(codigoAerolinea: string) {
    this.source = sourceDe(codigoAerolinea);
  }

  traducir(evento: EventoInterno): CloudEvent {
    return {
      specversion: '1.0',
      type: `${PREFIJO_TIPO_CLOUDEVENT}${evento.tipo}`,
      source: this.source,
      id: evento.eventId,
      time: evento.ocurridoEn.toISOString(),
      subject: subjectDe(evento.tipo, evento.data),
      datacontenttype: 'application/json',
      correlationid: evento.correlationId,
      data: evento.data,
    };
  }
}
