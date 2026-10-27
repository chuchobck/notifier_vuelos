import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { correlacionActual, nuevoCorrelationId } from '../../common/contexto/correlation-id';
import { CODIGO_SIN_EQUIVALENTE } from '../../common/errores/codigo-error';
import { ErrorNegocio } from '../../common/errores/error-negocio';
import { Reloj } from '../../common/reloj';
import { traceparentActivo } from '../../observabilidad/contexto-traza';
import { Observabilidad } from '../../observabilidad/observabilidad';
import { PrismaService } from '../../prisma/prisma.service';
import { canonico } from './contrato/compatibilidad';
import { RegistroEsquemas } from './contrato/registro-esquemas';
import { aWebhookPayload } from './evento.mapper';
import { ResultadoPublicacion, SobreEvento } from './evento.modelo';
import { EventoRepository } from './evento.repository';

/**
 * POST /internal/v1/events: recibe un evento del core, lo valida contra el esquema de su tipo y
 * versión, y en UNA transacción lo guarda y crea una entrega PENDIENTE por cada suscripción
 * activa de su dueño que escucha ese tipo, con el WebhookPayload ya congelado. El resultado sale
 * después del commit: un 202 significa que el evento y sus entregas ya están guardados.
 *
 * Idempotente por eventId: una repetición con el mismo contenido no hace nada (200); con otro
 * contenido es un error del publicador (409), porque un eventId identifica un solo hecho.
 * Nunca hay HTTP aquí: el envío es de EntregaWebhooks, aparte.
 */
@Injectable()
export class PublicacionEventos {
  private readonly logger = new Logger(PublicacionEventos.name);

  constructor(
    private readonly registro: RegistroEsquemas,
    private readonly repositorio: EventoRepository,
    private readonly prisma: PrismaService,
    private readonly reloj: Reloj,
    private readonly observabilidad: Observabilidad,
  ) {}

  async publicar(cuerpo: unknown, publicadoPor: string): Promise<ResultadoPublicacion> {
    const validacion = this.registro.validar(cuerpo);
    if (!validacion.valido) {
      throw new ErrorNegocio(validacion.status, CODIGO_SIN_EQUIVALENTE, validacion.detalle, {
        invalidParams: validacion.invalidParams,
      });
    }
    const sobre = validacion.sobre;
    const huella = huellaDe(sobre);
    const ahora = this.reloj.ahora();

    const resultado = await this.prisma.transaccion(async (tx) => {
      const nuevo = await this.repositorio.guardar(tx, {
        eventId: sobre.eventId,
        tipo: sobre.eventType,
        version: sobre.schemaVersion,
        idPropietario: sobre.ownerId,
        data: sobre.data,
        ocurrido: new Date(sobre.occurredAt),
        recibido: ahora,
        huella,
        publicadoPor,
        // El del sobre; si no, el X-Correlation-Id de la publicación (el core lo manda si el
        // hecho tenía uno; si no, el que generó este servicio al recibirla)
        correlationId: sobre.correlationId ?? correlacionActual() ?? nuevoCorrelationId(),
        traceparent: traceparentActivo(),
      });
      if (!nuevo) {
        const existente = await this.repositorio.existente(tx, sobre.eventId);
        if (existente.huella !== huella) {
          throw new ErrorNegocio(
            409,
            CODIGO_SIN_EQUIVALENTE,
            `Event ${sobre.eventId} was already published with different content`,
          );
        }
        return { eventId: sobre.eventId, entregas: existente.entregas, duplicado: true };
      }
      const entregas = await this.repositorio.repartir(tx, {
        eventId: sobre.eventId,
        tipo: sobre.eventType,
        idPropietario: sobre.ownerId,
        cuerpo: aWebhookPayload(sobre),
        ahora,
      });
      return { eventId: sobre.eventId, entregas, duplicado: false };
    });

    this.observabilidad.notifier.eventosRecibidos.inc({
      result: resultado.duplicado ? 'duplicate' : 'accepted',
    });
    // Ni el dueño ni el data: el eventId y el tipo bastan para seguir el evento
    this.logger.log(
      `Evento ${resultado.eventId} (${sobre.eventType} ${sobre.schemaVersion}) ` +
        `${resultado.duplicado ? 'repetido' : 'aceptado'}: ${resultado.entregas} entregas`,
    );
    return resultado;
  }
}

/** SHA-256 del sobre canónico (claves ordenadas): el mismo contenido da la misma huella. */
export function huellaDe(sobre: SobreEvento): string {
  return createHash('sha256').update(canonico(sobre)).digest('hex');
}
