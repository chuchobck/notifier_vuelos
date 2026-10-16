import { ApiProperty } from '@nestjs/swagger';
import { EVENTOS_WEBHOOK } from '../../compartido/eventos-webhook';

/**
 * El sobre que publica el core, solo para la documentación: lo valida el JSON Schema de su tipo
 * y versión (contracts/events/<tipo>.v<mayor>.json), no class-validator.
 */
export class SobreEventoDto {
  @ApiProperty({ format: 'uuid', description: 'Id del hecho; la clave de idempotencia' })
  eventId!: string;

  @ApiProperty({ enum: EVENTOS_WEBHOOK, example: 'booking.confirmed' })
  eventType!: string;

  @ApiProperty({
    example: '1.0',
    pattern: '^[1-9][0-9]{0,2}\\.[0-9]{1,3}$',
    description: 'mayor.menor; el mayor elige contracts/events/<tipo>.v<mayor>.json',
  })
  schemaVersion!: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-10-16T14:30:00.000Z',
    description: 'Cuándo pasó el hecho, en UTC (sufijo Z)',
  })
  occurredAt!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Dueño del hecho (sub del token que creó el recurso): solo sus suscripciones lo reciben',
  })
  ownerId!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: {
      bookingId: '3f0c6a9e-2b1d-4c8e-9a7f-5d4e3c2b1a09',
      pnr: 'Q7K2MX',
      status: 'CONFIRMED',
    },
    description: 'Lo propio de cada tipo (docs/EVENTOS.md); sin campos de más',
  })
  data!: Record<string, unknown>;
}

/** Respuesta de 202 (aceptado por primera vez) y de 200 (repetición con el mismo contenido). */
export class EventoAceptadoDto {
  @ApiProperty({ format: 'uuid' })
  eventId!: string;

  @ApiProperty({
    example: 2,
    description: 'Entregas del evento: una por suscripción activa del dueño que escucha el tipo',
  })
  deliveries!: number;

  @ApiProperty({ example: false, description: 'true si el eventId ya se había publicado (200)' })
  duplicate!: boolean;
}
