import { Injectable } from '@nestjs/common';
import { TransaccionNotificaciones } from '../../prisma/prisma.service';
import { CloudEvent } from './traductores/cloudevent.v2';
import { WebhookPayload } from './traductores/webhook-payload.v1';

export interface EventoNuevo {
  eventId: string;
  tipo: string;
  version: string;
  idPropietario: string;
  data: Record<string, unknown>;
  ocurrido: Date;
  recibido: Date;
  huella: string;
  publicadoPor: string;
  /** X-Correlation-Id del proceso que originó el hecho (nunca vacío). */
  correlationId: string;
  /** traceparent del span que recibió el evento, para que cada entrega cuelgue de su traza. */
  traceparent: string | null;
}

/**
 * Eventos recibidos (evento) y su reparto a la bandeja de salida (entrega). Todo dentro de la
 * transacción que abre el service: el evento y sus entregas se confirman o se deshacen juntos.
 */
@Injectable()
export class EventoRepository {
  /**
   * Guarda el evento si su eventId no existía. Devuelve false si ya existía: el único
   * (uq_evento_id_evento) hace que una publicación simultánea del mismo eventId espere a la
   * primera y no duplique nada.
   */
  async guardar(tx: TransaccionNotificaciones, evento: EventoNuevo): Promise<boolean> {
    const filas = await tx.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO notificaciones.evento
             (id_evento, tipo, version_esquema, id_propietario, payload, ocurrido_en, recibido_en,
              huella, publicado_por, correlation_id, traceparent)
      VALUES (${evento.eventId}::uuid, ${evento.tipo}, ${evento.version}, ${evento.idPropietario},
              ${JSON.stringify(evento.data)}::jsonb, ${evento.ocurrido}::timestamptz,
              ${evento.recibido}::timestamptz, ${evento.huella}, ${evento.publicadoPor},
              ${evento.correlationId}, ${evento.traceparent})
      ON CONFLICT ON CONSTRAINT uq_evento_id_evento DO NOTHING
      RETURNING id`;
    return filas.length === 1;
  }

  /** La huella de un evento ya guardado y cuántas entregas tiene. */
  async existente(
    tx: TransaccionNotificaciones,
    eventId: string,
  ): Promise<{ huella: string; entregas: number }> {
    const [fila] = await tx.$queryRaw<Array<{ huella: string; entregas: number }>>`
      SELECT e.huella,
             (SELECT count(*)::int FROM notificaciones.entrega en WHERE en.id_evento = e.id_evento)
               AS entregas
        FROM notificaciones.evento e
       WHERE e.id_evento = ${eventId}::uuid`;
    return fila;
  }

  /**
   * Una entrega PENDIENTE por cada suscripción ACTIVA del dueño que escucha el tipo, con el
   * cuerpo ya congelado en el formato de esa suscripción (el WebhookPayload v1 o el CloudEvent
   * v2), en un solo INSERT ... SELECT (como el core). Si el dueño no tiene suscriptores, no
   * inserta nada. Devuelve cuántas creó.
   */
  async repartir(
    tx: TransaccionNotificaciones,
    reparto: {
      eventId: string;
      tipo: string;
      idPropietario: string;
      cuerpos: { v1: WebhookPayload; v2: CloudEvent };
      ahora: Date;
    },
  ): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO notificaciones.entrega
             (suscripcion_id, id_evento, cuerpo, proximo_intento, fecha_creacion, fecha_actualizacion)
      SELECT s.id, ${reparto.eventId}::uuid,
             (CASE s.formato WHEN 'v2' THEN ${JSON.stringify(reparto.cuerpos.v2)}::jsonb
                             ELSE ${JSON.stringify(reparto.cuerpos.v1)}::jsonb END),
             ${reparto.ahora}::timestamptz, ${reparto.ahora}::timestamptz, ${reparto.ahora}::timestamptz
        FROM notificaciones.suscripcion s
        JOIN notificaciones.suscripcion_evento se
          ON se.suscripcion_id = s.id AND se.tipo_evento = ${reparto.tipo}
       WHERE s.id_propietario = ${reparto.idPropietario} AND s.activo
      ON CONFLICT ON CONSTRAINT uq_entrega_suscripcion_evento DO NOTHING`;
  }
}
