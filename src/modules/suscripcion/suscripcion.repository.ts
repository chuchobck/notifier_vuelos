import { Injectable } from '@nestjs/common';
import { PrismaService, TransaccionNotificaciones } from '../../prisma/prisma.service';
import { EVENTOS_WEBHOOK, EventoWebhook } from '../compartido/eventos-webhook';
import { Suscripcion } from './suscripcion.modelo';

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
      eventos: readonly EventoWebhook[];
      activo?: boolean;
      fecha: Date;
      /** La fecha de alta original (al importar del core); sin ella, `fecha`. */
      fechaCreacion?: Date;
    },
  ): Promise<string> {
    const fila = await tx.suscripcion.create({
      data: {
        ...(nueva.id === undefined ? {} : { id: nueva.id }),
        id_propietario: nueva.idPropietario,
        url: nueva.url,
        secreto_cifrado: nueva.secretoCifrado,
        activo: nueva.activo ?? true,
        fecha_creacion: nueva.fechaCreacion ?? nueva.fecha,
        fecha_actualizacion: nueva.fecha,
      },
      select: { id: true },
    });
    await tx.suscripcion_evento.createMany({
      data: nueva.eventos.map((tipo) => ({ suscripcion_id: fila.id, tipo_evento: tipo })),
    });
    return fila.id;
  }

  /** Si existe una suscripción con ese id (activa o no). */
  async existe(tx: TransaccionNotificaciones, id: string): Promise<boolean> {
    return (await tx.suscripcion.count({ where: { id } })) > 0;
  }

  /** Si el usuario ya tiene una suscripción activa con esa URL. */
  async tieneUrlActiva(
    tx: TransaccionNotificaciones,
    idPropietario: string,
    url: string,
  ): Promise<boolean> {
    return (
      (await tx.suscripcion.count({
        where: { id_propietario: idPropietario, url, activo: true },
      })) > 0
    );
  }

  /** Las suscripciones activas del usuario, de la más vieja a la más nueva. */
  async activasDe(idPropietario: string): Promise<Suscripcion[]> {
    const filas = await this.prisma.db.suscripcion.findMany({
      where: { id_propietario: idPropietario, activo: true },
      orderBy: [{ fecha_creacion: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        url: true,
        secreto_cifrado: true,
        suscripcion_evento: { select: { tipo_evento: true } },
      },
    });
    return filas.map((f) => ({
      id: f.id,
      url: f.url,
      secretoCifrado: f.secreto_cifrado,
      eventos: enOrdenDelContrato(f.suscripcion_evento.map((e) => e.tipo_evento)),
    }));
  }

  /**
   * Da de baja (lógica) la suscripción activa del usuario. Devuelve su URL y sus eventos (para
   * la auditoría), o null si no existía, no estaba activa o es de otro usuario.
   */
  async desactivar(
    tx: TransaccionNotificaciones,
    id: string,
    idPropietario: string,
    fecha: Date,
  ): Promise<{ url: string; eventos: EventoWebhook[] } | null> {
    const actual = await tx.suscripcion.findFirst({
      where: { id, id_propietario: idPropietario, activo: true },
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
      eventos: enOrdenDelContrato(actual.suscripcion_evento.map((e) => e.tipo_evento)),
    };
  }
}

/** Los tipos guardados, en el orden del contrato (la base no garantiza un orden). */
function enOrdenDelContrato(tipos: string[]): EventoWebhook[] {
  return EVENTOS_WEBHOOK.filter((tipo) => tipos.includes(tipo));
}
