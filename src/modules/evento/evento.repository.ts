import { Injectable } from '@nestjs/common';
import { PrismaService, TransaccionNotificaciones } from '../../prisma/prisma.service';
import { TipoEvento } from '../compartido/eventos-webhook';
import { EventoInterno } from './traductores/evento-interno';
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
  constructor(private readonly prisma: PrismaService) {}

  /**
   * La posición interna (evento.id) del evento `eventId` en el feed de `idPropietario`, o null si
   * no existe o es de otro dueño (los dos casos son iguales para quien pregunta).
   */
  async posicionEnFeed(idPropietario: string, eventId: string): Promise<bigint | null> {
    const fila = await this.prisma.db.evento.findFirst({
      where: { id_evento: eventId, id_propietario: idPropietario },
      select: { id: true },
    });
    return fila?.id ?? null;
  }

  /**
   * Una página del feed: los eventos de `idPropietario` (y solo de él) posteriores a `desde`, en
   * orden de llegada (evento.id, el índice ix_evento_feed), opcionalmente de un tipo.
   */
  async feed(
    idPropietario: string,
    pagina: { desde: bigint | null; tipo: TipoEvento | null; limite: number },
  ): Promise<EventoInterno[]> {
    const filas = await this.prisma.db.evento.findMany({
      where: {
        id_propietario: idPropietario,
        ...(pagina.desde === null ? {} : { id: { gt: pagina.desde } }),
        ...(pagina.tipo === null ? {} : { tipo: pagina.tipo }),
      },
      orderBy: { id: 'asc' },
      take: pagina.limite,
      select: {
        id_evento: true,
        tipo: true,
        ocurrido_en: true,
        correlation_id: true,
        payload: true,
      },
    });
    return filas.map((f) => ({
      eventId: f.id_evento,
      tipo: f.tipo as TipoEvento,
      ocurridoEn: f.ocurrido_en,
      correlationId: f.correlation_id,
      data: f.payload as Record<string, unknown>,
    }));
  }

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
