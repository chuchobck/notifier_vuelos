import { Injectable, Logger } from '@nestjs/common';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  conCorrelacion,
  esCorrelationIdValido,
  nuevoCorrelationId,
} from '../../common/contexto/correlation-id';
import { ErrorNegocio } from '../../common/errores/error-negocio';
import { Reloj } from '../../common/reloj';
import { Observabilidad } from '../../observabilidad/observabilidad';
import { marcarError } from '../../observabilidad/trazas';
import { PublicacionEventos } from '../evento/evento.service';
import { CanalAmqp, MensajeAmqp, OpcionesPublicacionAmqp } from './canal-amqp';
import {
  CABECERAS_AMQP,
  EstadoMuerto,
  PUBLICADO_POR_AMQP,
  REGLAS_AMQP,
  TOPOLOGIA,
} from './topologia';

/** Qué se hace con un mensaje ya examinado. */
export type Decision =
  | { tipo: 'aceptado'; duplicado: boolean }
  | { tipo: 'muerto'; estado: EstadoMuerto; motivo: string }
  | { tipo: 'reintento'; motivo: string };

/**
 * Procesa UN mensaje de la cola: lo pasa por la MISMA `PublicacionEventos.publicar` que usa
 * POST /internal/v1/events (validación, transacción, idempotencia por eventId) y decide su suerte:
 *
 * - aceptado o repetido con el mismo contenido: ack;
 * - JSON roto, sobre inválido o tipo desconocido (400/422) y mismo eventId con otro contenido
 *   (409): a la DLQ con el motivo en `x-motivo`, y ack. Reintentar no cambiaría nada;
 * - cualquier otro error (base caída, timeout...): a la cola de reintento, que lo devuelve a la
 *   principal a los 30 s; al quinto intento, a la DLQ.
 *
 * El ack siempre va DESPUÉS de que el broker confirme la copia en la cola de reintento o en la
 * DLQ: un fallo en medio deja el mensaje sin ack y el broker lo vuelve a entregar (la publicación
 * es idempotente). Nunca se registra el cuerpo del evento, y `x-motivo` nombra campos, no valores.
 */
@Injectable()
export class ProcesadorMensajes {
  private readonly logger = new Logger(ProcesadorMensajes.name);

  constructor(
    private readonly publicacion: PublicacionEventos,
    private readonly observabilidad: Observabilidad,
    private readonly reloj: Reloj,
  ) {}

  async procesar(canal: CanalAmqp, mensaje: MensajeAmqp): Promise<void> {
    const { notifier, trazas } = this.observabilidad;
    notifier.amqpConsumidos.inc();

    const cabeceras = mensaje.properties.headers ?? {};
    const traceparent = cabeceras[CABECERAS_AMQP.traceparent];
    // Continúa la traza del mensaje (con TRACE_TRUST_INCOMING): el span de consumo es su hijo
    const span = trazas.iniciar(
      'amqp consume',
      SpanKind.CONSUMER,
      {},
      trazas.contextoEntrante(typeof traceparent === 'string' ? traceparent : undefined),
    );
    const correlacion = correlacionDe(mensaje);
    try {
      const decision = await trazas.conSpan(span, () =>
        conCorrelacion(correlacion, () => this.decidir(mensaje)),
      );
      if (decision.tipo === 'reintento') marcarError(span, 'unavailable');
      else if (decision.tipo === 'muerto') span.setStatus({ code: SpanStatusCode.ERROR });
      await conCorrelacion(correlacion, () => this.aplicar(canal, mensaje, decision));
    } finally {
      span.end();
    }
  }

  private async decidir(mensaje: MensajeAmqp): Promise<Decision> {
    let cuerpo: unknown;
    try {
      cuerpo = JSON.parse(mensaje.content.toString('utf8'));
    } catch {
      return { tipo: 'muerto', estado: 'JSON_INVALIDO', motivo: 'El cuerpo no es JSON' };
    }
    try {
      const resultado = await this.publicacion.publicar(cuerpo, PUBLICADO_POR_AMQP);
      return { tipo: 'aceptado', duplicado: resultado.duplicado };
    } catch (error) {
      if (error instanceof ErrorNegocio) {
        if (error.status === 400 || error.status === 422) {
          return {
            tipo: 'muerto',
            estado: 'SOBRE_INVALIDO',
            motivo: motivoDe(error),
          };
        }
        if (error.status === 409) {
          return { tipo: 'muerto', estado: 'CONFLICTO', motivo: motivoDe(error) };
        }
      }
      // Solo la clase del error: el mensaje de una base caída podría llevar datos de conexión
      return { tipo: 'reintento', motivo: error instanceof Error ? error.name : 'Error' };
    }
  }

  private async aplicar(canal: CanalAmqp, mensaje: MensajeAmqp, decision: Decision): Promise<void> {
    const { notifier } = this.observabilidad;
    const id = mensaje.properties.messageId ?? 'sin-messageId';

    if (decision.tipo === 'aceptado') {
      canal.ack(mensaje);
      notifier.amqpResultados.inc({ result: decision.duplicado ? 'duplicate' : 'accepted' });
      return;
    }

    const previos = intentosPrevios(mensaje);
    if (decision.tipo === 'reintento' && previos + 1 < REGLAS_AMQP.maximoIntentos) {
      await canal.publicarEnCola(
        TOPOLOGIA.colaReintento,
        mensaje.content,
        opcionesDe(mensaje, {
          [CABECERAS_AMQP.intentos]: previos + 1,
          [CABECERAS_AMQP.routingKeyOriginal]: routingKeyOriginal(mensaje),
        }),
      );
      canal.ack(mensaje);
      notifier.amqpResultados.inc({ result: 'retried' });
      this.logger.warn(
        `Mensaje ${id}: error transitorio (${decision.motivo}), reintento ${previos + 1} de ` +
          `${REGLAS_AMQP.maximoIntentos - 1}`,
      );
      return;
    }

    const estado: EstadoMuerto =
      decision.tipo === 'muerto' ? decision.estado : 'REINTENTOS_AGOTADOS';
    const motivo =
      decision.tipo === 'muerto'
        ? decision.motivo
        : `Error transitorio tras ${previos + 1} intentos: ${decision.motivo}`;
    // Sin x-death ni x-intentos: quien reencole desde la DLQ empieza con intentos frescos
    const limpias = opcionesDe(mensaje, {
      [CABECERAS_AMQP.motivo]: motivo.slice(0, 500),
      [CABECERAS_AMQP.estado]: estado,
      [CABECERAS_AMQP.intentosPrevios]: previos + 1,
      [CABECERAS_AMQP.routingKeyOriginal]: routingKeyOriginal(mensaje),
      [CABECERAS_AMQP.fecha]: this.reloj.ahora().toISOString(),
    });
    delete limpias.headers[CABECERAS_AMQP.muertes];
    delete limpias.headers[CABECERAS_AMQP.intentos];
    await canal.publicarEnCola(TOPOLOGIA.colaMuertos, mensaje.content, limpias);
    canal.ack(mensaje);
    notifier.amqpResultados.inc({ result: 'dead_lettered' });
    this.logger.error(`Mensaje ${id} a la DLQ (${estado}): ${motivo}`);
  }
}

/** `detail` del error (nombra campos, nunca valores) con el status delante. */
function motivoDe(error: ErrorNegocio): string {
  const campos = (error.invalidParams ?? []).map((p) => p.name).join(', ');
  return `${error.status} ${error.detalle ?? error.code}${campos ? ` [${campos}]` : ''}`;
}

/** El correlation id del mensaje (propiedad AMQP o cabecera) si es válido; si no, se deja al sobre. */
function correlacionDe(mensaje: MensajeAmqp): string {
  const candidato =
    mensaje.properties.correlationId ?? mensaje.properties.headers?.['X-Correlation-Id'];
  return esCorrelationIdValido(candidato) ? candidato : nuevoCorrelationId();
}

/**
 * Cuántas veces ya se intentó este mensaje: lo que el broker cuenta en `x-death` por expiración
 * en la cola de reintento, o el `x-intentos` que anotamos al reenviarlo, el mayor de los dos
 * (algunos brokers no conservan el `x-death` de un mensaje que un cliente vuelve a publicar).
 */
export function intentosPrevios(mensaje: MensajeAmqp): number {
  const cabeceras = mensaje.properties.headers ?? {};
  const muertes = cabeceras[CABECERAS_AMQP.muertes];
  let porMuertes = 0;
  if (Array.isArray(muertes)) {
    for (const m of muertes as unknown as Array<Record<string, unknown>>) {
      if (m?.queue === TOPOLOGIA.colaReintento && typeof m.count === 'number') {
        porMuertes += m.count;
      }
    }
  }
  const propio = cabeceras[CABECERAS_AMQP.intentos];
  return Math.max(porMuertes, typeof propio === 'number' ? propio : 0);
}

function routingKeyOriginal(mensaje: MensajeAmqp): string {
  const guardada = mensaje.properties.headers?.[CABECERAS_AMQP.routingKeyOriginal];
  return typeof guardada === 'string' ? guardada : mensaje.fields.routingKey;
}

function opcionesDe(mensaje: MensajeAmqp, extra: Record<string, unknown>): OpcionesPublicacionAmqp {
  return {
    messageId: mensaje.properties.messageId,
    correlationId: mensaje.properties.correlationId,
    contentType: mensaje.properties.contentType,
    headers: { ...(mensaje.properties.headers ?? {}), ...extra },
  };
}
