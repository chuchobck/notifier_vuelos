import { Injectable } from '@nestjs/common';
import { PrismaService, TransaccionNotificaciones } from '../../prisma/prisma.service';
import { enOrdenDelFormato, TipoEvento } from '../compartido/eventos-webhook';
import { FormatoEntrega, Suscripcion } from './suscripcion.modelo';

/**
 * Suscripciones (suscripcion) y los eventos que escuchan (suscripcion_evento, sin API propia).
 * Las bajas son lógicas (`activo = false`); nada se borra. El secreto llega y sale cifrado: este
 * repository nunca lo ve en claro.
 */
@Injectable()
export class SuscripcionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cuántas suscripciones activas tiene el usuario, con un candado de transacción por usuario:
   * dos altas simultáneas se esperan y la segunda cuenta la primera, así nunca pasan del máximo.
   */
  async contarActivasBloqueando(
    tx: TransaccionNotificaciones,
    idPropietario: string,
  ): Promise<number> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'suscripcion:' + idPropietario}, 0))`;
    return tx.suscripcion.count({ where: { id_propietario: idPropietario, activo: true } });
  }

  /** Crea la suscripción y sus eventos. Una URL activa repetida del usuario viola el único (409). */
  async crear(
    tx: TransaccionNotificaciones,
    nueva: {
      id?: string;
      idPropietario: string;
      url: string;
      secretoCifrado: string;
      eventos: readonly TipoEvento[];
      /** v1 (/flights/v1/webhooks, por defecto) o v2 (/api/v2/vuelos/webhooks). */
      formato?: FormatoEntrega;
      activo?: boolean;
      fecha: Date;
      /** La fecha de alta original (al importar del core); sin ella, `fecha`. */
      fechaCreacion?: Date;
    },
  ): Promise<{ id: string; fechaCreacion: Date }> {
    const fila = await tx.suscripcion.create({
      data: {
        ...(nueva.id === undefined ? {} : { id: nueva.id }),
        id_propietario: nueva.idPropietario,
        url: nueva.url,
        secreto_cifrado: nueva.secretoCifrado,
        formato: nueva.formato ?? 'v1',
        activo: nueva.activo ?? true,
        fecha_creacion: nueva.fechaCreacion ?? nueva.fecha,
        fecha_actualizacion: nueva.fecha,
      },
      select: { id: true, fecha_creacion: true },
    });
    await tx.suscripcion_evento.createMany({
      data: nueva.eventos.map((tipo) => ({ suscripcion_id: fila.id, tipo_evento: tipo })),
    });
    return { id: fila.id, fechaCreacion: fila.fecha_creacion };
  }

  /** Si existe una suscripción con ese id (activa o no). */
  async existe(tx: TransaccionNotificaciones, id: string): Promise<boolean> {
    return (await tx.suscripcion.count({ where: { id } })) > 0;
  }

  /**
   * Si el usuario ya tiene otra suscripción activa con esa URL (con `salvoId`, una de id distinto).
   * Se pregunta antes de insertar para no chocar con uq_suscripcion_propietario_url: PostgreSQL
   * escribe en SU log el DETAIL de esa violación, con la URL completa. `salvoId` importa al
   * importar: una importación simultánea del mismo archivo puede confirmar esa misma suscripción
   * entre dos consultas (READ COMMITTED), y no es un choque de URL.
   */
  async tieneUrlActiva(
    tx: TransaccionNotificaciones,
    idPropietario: string,
    url: string,
    salvoId?: string,
  ): Promise<boolean> {
    const otras = await tx.suscripcion.count({
      where: {
        id_propietario: idPropietario,
        url,
        activo: true,
        ...(salvoId === undefined ? {} : { id: { not: salvoId } }),
      },
    });
    return otras > 0;
  }

  /**
   * Las suscripciones activas del usuario en ese formato, de la más vieja a la más nueva. Cada API
   * ve solo las suyas: /flights/v1/webhooks no lista una v2 (sus tipos no son del contrato 1.5).
   */
  async activasDe(idPropietario: string, formato: FormatoEntrega): Promise<Suscripcion[]> {
    const filas = await this.prisma.db.suscripcion.findMany({
      where: { id_propietario: idPropietario, activo: true, formato },
      orderBy: [{ fecha_creacion: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        url: true,
        secreto_cifrado: true,
        fecha_creacion: true,
        suscripcion_evento: { select: { tipo_evento: true } },
      },
    });
    return filas.map((f) => ({
      id: f.id,
      url: f.url,
      secretoCifrado: f.secreto_cifrado,
      fechaCreacion: f.fecha_creacion,
      eventos: enOrdenDelFormato(
        f.suscripcion_evento.map((e) => e.tipo_evento),
        formato,
      ),
    }));
  }

  /**
   * Da de baja (lógica) la suscripción activa del usuario en ese formato. Devuelve su URL y sus
   * eventos (para la auditoría), o null si no existía, no estaba activa, es de otro usuario o se
   * creó por la otra API (una v2 no se da de baja por /flights/v1/webhooks, ni al revés).
   */
  async desactivar(
    tx: TransaccionNotificaciones,
    id: string,
    idPropietario: string,
    fecha: Date,
    formato: FormatoEntrega,
  ): Promise<{ url: string; eventos: TipoEvento[] } | null> {
    const actual = await tx.suscripcion.findFirst({
      where: { id, id_propietario: idPropietario, activo: true, formato },
      select: { url: true, suscripcion_evento: { select: { tipo_evento: true } } },
    });
    if (actual === null) return null;
    // Condicionado a que siga activa: de dos bajas simultáneas, solo una la da de baja
    const { count } = await tx.suscripcion.updateMany({
      where: { id, id_propietario: idPropietario, activo: true },
      data: { activo: false, fecha_actualizacion: fecha },
    });
    if (count !== 1) return null;
    return {
      url: actual.url,
      eventos: enOrdenDelFormato(
        actual.suscripcion_evento.map((e) => e.tipo_evento),
        formato,
      ),
    };
  }
}
