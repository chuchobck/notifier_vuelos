import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { EVENTOS, TipoEvento } from '../../../compartido/eventos-webhook';

/** Tamaño de página del feed (parámetro `limit` de listOutboxEvents). */
export const LIMITE_FEED = { minimo: 1, maximo: 100, porDefecto: 20 };

/** La query de GET /api/v2/vuelos/eventos (listOutboxEvents). */
export class ConsultaFeedDto {
  @ApiPropertyOptional({
    minimum: LIMITE_FEED.minimo,
    maximum: LIMITE_FEED.maximo,
    default: LIMITE_FEED.porDefecto,
  })
  @Type(() => Number)
  @IsInt()
  @Min(LIMITE_FEED.minimo)
  @Max(LIMITE_FEED.maximo)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Id del último evento ya procesado (el `id` de su CloudEvent, o `metadata.next_after`): ' +
      'devuelve los que llegaron después',
  })
  @IsUUID()
  @IsOptional()
  after?: string;

  @ApiPropertyOptional({ enum: EVENTOS, enumName: 'VuelosEventName', example: 'booking.confirmed' })
  @IsIn(EVENTOS)
  @IsOptional()
  type?: TipoEvento;
}

/** Un CloudEvent del feed (VuelosCloudEvent), solo para la documentación. */
export class CloudEventDto {
  @ApiProperty({ enum: ['1.0'] })
  specversion!: '1.0';

  @ApiProperty({ example: 'ec.edu.epn.booking.vuelos.booking.confirmed' })
  type!: string;

  @ApiProperty({ example: '/aerolineas/quinde/vuelos' })
  source!: string;

  @ApiProperty({ format: 'uuid', description: 'El eventId: el mismo que llegó por webhook' })
  id!: string;

  @ApiProperty({ format: 'date-time' })
  time!: string;

  @ApiProperty({ description: 'bookingId, holdId o <flightNumber>/<date>' })
  subject!: string;

  @ApiProperty({ enum: ['application/json'] })
  datacontenttype!: 'application/json';

  @ApiProperty({ example: 'corr-vuelos-7f3a9c' })
  correlationid!: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  data!: Record<string, unknown>;
}

export class MetadatosFeedDto {
  @ApiProperty({ example: 1, description: 'Eventos en esta página' })
  total!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description:
      'El id del último evento de la página (para pedir la siguiente con `after`); null si la ' +
      'página vino vacía',
  })
  next_after!: string | null;

  @ApiProperty({ format: 'date-time' })
  timestamp!: string;
}

/** VuelosEventosResponse del contrato v2. */
export class FeedEventosDto {
  @ApiProperty({ type: [CloudEventDto] })
  events!: CloudEventDto[];

  @ApiProperty({ type: MetadatosFeedDto })
  metadata!: MetadatosFeedDto;
}
