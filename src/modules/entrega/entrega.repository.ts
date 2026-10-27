import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditoriaSuscripciones } from '../auditoria/auditoria.service';
import { enOrdenDelFormato } from '../compartido/eventos-webhook';
import { FormatoEntrega } from '../evento/traductores/evento-interno';

/**
 * La bandeja de salida (entrega): tomar las pendientes, anotar cada intento y dar de baja la
 * suscripción que solo falla. Es la SQL de EntregaRepository del core sobre las tablas de este
 * esquema; el encolado lo hace EventoRepository al recibir el evento.
 */
@Injectable()
export class EntregaRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditoria: AuditoriaSuscripciones,
  ) {}

  /**
   * Toma hasta `limite` entregas PENDIENTE cuya hora ya llegó y les cuenta el intento. Cada fila
   * se elige con FOR UPDATE SKIP LOCKED: dos procesos a la vez nunca toman la misma. Al tomarla
   * se le corre `proximo_intento` al fin del arrendamiento (`ahora + arrendamientoSegundos`),
   * así el envío HTTP ocurre FUERA de toda transacción y, si el proceso muere a medio envío, la
   * entrega vuelve a estar disponible sola cuando el arrendamiento vence (el intento ya contó).
   */
  async reclamar(
    ahora: Date,
    limite: number,
    arrendamientoSegundos: number,
  ): Promise<EntregaReclamada[]> {
    return this.prisma.db.$queryRaw<EntregaReclamada[]>`
      WITH elegidas AS (
        SELECT e.id
          FROM notificaciones.entrega e
         WHERE e.estado = 'PENDIENTE' AND e.proximo_intento <= ${ahora}::timestamptz
         ORDER BY e.proximo_intento, e.id
         LIMIT ${limite}
           FOR UPDATE OF e SKIP LOCKED
      ), reclamadas AS (
        UPDATE notificaciones.entrega e
           SET intentos = e.intentos + 1,
               proximo_intento = ${ahora}::timestamptz + make_interval(secs => ${arrendamientoSegundos}),
               fecha_actualizacion = ${ahora}::timestamptz
          FROM elegidas
         WHERE e.id = elegidas.id
        RETURNING e.id, e.suscripcion_id, e.id_evento, e.intentos, e.cuerpo
      )
      SELECT r.id AS "id", r.suscripcion_id AS "suscripcionId", r.id_evento AS "eventId",
             ev.tipo AS "tipo", r.intentos::int AS "intentos", r.cuerpo AS "cuerpo",
             s.url AS "url", s.secreto_cifrado AS "secretoCifrado", s.activo AS "suscripcionActiva",
             s.formato AS "formato", ev.correlation_id AS "correlationId",
             ev.traceparent AS "traceparent"
        FROM reclamadas r
        JOIN notificaciones.suscripcion s ON s.id = r.suscripcion_id
        JOIN notificaciones.evento ev     ON ev.id_evento = r.id_evento
       ORDER BY r.id`;
  }

  /**
   * Anota cómo salió el intento `intentos` de la entrega. UPDATE condicionado a que la fila siga
   * PENDIENTE y en ese mismo intento: si el arrendamiento venció y otro proceso la retomó, el
   * resultado atrasado no pisa al nuevo. `proximoIntento` null con fallo = FALLIDO definitivo. En
   * un estado final `proximo_intento` queda en la hora del último intento (no en la del
   * arrendamiento). Devuelve el estado en que quedó, o null si no se aplicó.
   */
  async registrarResultado(
    id: bigint,
    intentos: number,
    ahora: Date,
    resultado: { codigoHttp: number | null; error: string | null },
    proximoIntento: Date | null,
  ): Promise<EstadoEntrega | null> {
    const exito =
      resultado.codigoHttp !== null && resultado.codigoHttp >= 200 && resultado.codigoHttp < 300;
    const filas = await this.prisma.db.$queryRaw<Array<{ estado: EstadoEntrega }>>`
      UPDATE notificaciones.entrega
         SET estado = (CASE WHEN ${exito} THEN 'ENTREGADO'
                            WHEN ${proximoIntento}::timestamptz IS NULL THEN 'FALLIDO'
                            ELSE 'PENDIENTE' END)::notificaciones.estado_entrega,
             proximo_intento = COALESCE(${proximoIntento}::timestamptz, ${ahora}::timestamptz),
             ultimo_codigo_http = ${resultado.codigoHttp}::smallint,
             ultimo_error = ${exito ? null : (resultado.error ?? 'HTTP_' + resultado.codigoHttp)}::text,
             fecha_actualizacion = ${ahora}::timestamptz
       WHERE id = ${id} AND estado = 'PENDIENTE' AND intentos = ${intentos}
      RETURNING estado::text AS estado`;
    return filas[0]?.estado ?? null;
  }

  /**
   * Cuántas entregas están PENDIENTE y desde cuándo espera la más vieja (null si no hay ninguna),
   * para los gauges de /metrics. Una consulta sobre el índice parcial de PENDIENTE, con un plazo
   * en la base (`statement_timeout` de esta transacción): si tarda más, falla en vez de colgar.
   */
  async resumenPendientes(plazoMs: number): Promise<{ pendientes: number; desde: Date | null }> {
    const [, filas] = await this.prisma.db.$transaction([
      this.prisma.db.$executeRaw`SELECT set_config('statement_timeout', ${String(plazoMs)}, true)`,
      this.prisma.db.$queryRaw<Array<{ n: number; desde: Date | null }>>`
        SELECT count(*)::int AS n, min(fecha_creacion) AS desde
          FROM notificaciones.entrega WHERE estado = 'PENDIENTE'`,
    ]);
    return { pendientes: filas[0]?.n ?? 0, desde: filas[0]?.desde ?? null };
  }

  /**
   * Si las últimas `maximo` entregas ya resueltas de la suscripción (ENTREGADO o FALLIDO) son
   * todas FALLIDO, la da de baja (lógica) y lo audita sin actor (proceso interno), en la misma
   * transacción. Una entrega ENTREGADO corta la racha. Devuelve si la dio de baja.
   */
  desactivarSiSoloFalla(suscripcionId: string, maximo: number, ahora: Date): Promise<boolean> {
    return this.prisma.transaccion(async (tx) => {
      const [racha] = await tx.$queryRaw<Array<{ fallidas: number; total: number }>>`
        SELECT count(*) FILTER (WHERE estado::text = 'FALLIDO')::int AS fallidas, count(*)::int AS total
          FROM (SELECT estado
                  FROM notificaciones.entrega
                 WHERE suscripcion_id = ${suscripcionId}::uuid AND estado::text <> 'PENDIENTE'
                 ORDER BY fecha_actualizacion DESC, id DESC
                 LIMIT ${maximo}) ultimas`;
      if (racha.total < maximo || racha.fallidas < maximo) return false;

      const suscripcion = await tx.suscripcion.findFirst({
        where: { id: suscripcionId, activo: true },
        select: {
          id_propietario: true,
          url: true,
          formato: true,
          suscripcion_evento: { select: { tipo_evento: true } },
        },
      });
      if (suscripcion === null) return false;
      const { count } = await tx.suscripcion.updateMany({
        where: { id: suscripcionId, activo: true },
        data: { activo: false, fecha_actualizacion: ahora },
      });
      if (count !== 1) return false;
      const tipos = suscripcion.suscripcion_evento.map((e) => e.tipo_evento);
      await this.auditoria.registrar(
        tx,
        {
          accion: 'SUSCRIPCION_DESACTIVADA',
          suscripcionId,
          idPropietario: suscripcion.id_propietario,
          url: suscripcion.url,
          eventos: enOrdenDelFormato(tipos, suscripcion.formato === 'v2' ? 'v2' : 'v1'),
          motivo: 'FALLIDAS_SEGUIDAS',
        },
        ahora,
      );
      return true;
    });
  }
}

export type EstadoEntrega = 'PENDIENTE' | 'ENTREGADO' | 'FALLIDO';

/** Una entrega tomada para enviar, con lo que hace falta de su suscripción. */
export interface EntregaReclamada {
  id: bigint;
  suscripcionId: string;
  eventId: string;
  tipo: string;
  /** el intento que se está haciendo (1 el primero) */
  intentos: number;
  cuerpo: Record<string, unknown>;
  url: string;
  secretoCifrado: string;
  suscripcionActiva: boolean;
  /** El de la suscripción: decide las cabeceras, la firma y los reintentos. */
  formato: FormatoEntrega;
  /** X-Correlation-Id del evento: va en la cabecera y en cada línea de log del intento. */
  correlationId: string;
  /** traceparent del span que recibió el evento: el span CLIENT del intento cuelga de él. */
  traceparent: string | null;
}
