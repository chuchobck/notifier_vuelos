import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { EVENTOS_WEBHOOK, EventoWebhook } from '../../compartido/eventos-webhook';

/**
 * Los DTO copian components.schemas del contrato del core, con sus mismos nombres, y las mismas
 * reglas de validación que el core (dto/webhook.dto.ts de backend_vuelos).
 */

export const LARGO_MINIMO_SECRETO = 16;
export const LARGO_MAXIMO_SECRETO = 256;

/** components.schemas.WebhookSubscription al registrar: url, events y secret. */
export class SolicitudWebhookDto {
  @ApiProperty({
    example: 'https://partner.example.com/hooks/vuelos',
    format: 'uri',
    description:
      'https en producción; con NODE_ENV distinto de production también http://localhost. ' +
      'No se aceptan destinos que resuelvan a redes privadas, loopback, link-local o metadata',
  })
  @IsString()
  @MaxLength(2048)
  @Matches(/^https?:\/\/\S+$/, { message: '$property must be an http(s) URL without spaces' })
  url!: string;

  @ApiProperty({
    enum: EVENTOS_WEBHOOK,
    isArray: true,
    minItems: 1,
    example: ['booking.confirmed', 'booking.cancelled'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EVENTOS_WEBHOOK.length)
  @ArrayUnique()
  @IsIn(EVENTOS_WEBHOOK, {
    each: true,
    message: `each value in $property must be one of: ${EVENTOS_WEBHOOK.join(', ')}`,
  })
  events!: EventoWebhook[];

  @ApiProperty({
    minLength: LARGO_MINIMO_SECRETO,
    example: 'un-secreto-compartido-largo',
    description:
      'Con él se firma cada entrega (HMAC-SHA256). Se guarda cifrado y nunca se devuelve: las ' +
      'respuestas traen **** y sus últimos 4 caracteres',
  })
  @IsString()
  @MinLength(LARGO_MINIMO_SECRETO)
  @MaxLength(LARGO_MAXIMO_SECRETO)
  @Matches(/^\S+$/, { message: '$property must not contain spaces' })
  secret!: string;
}

/** components.schemas.WebhookSubscription al responder: el secreto va enmascarado. */
export class WebhookDto {
  @ApiProperty({ format: 'uuid', readOnly: true })
  id!: string;

  @ApiProperty({ example: 'https://partner.example.com/hooks/vuelos', format: 'uri' })
  url!: string;

  @ApiProperty({ enum: EVENTOS_WEBHOOK, isArray: true })
  events!: EventoWebhook[];

  @ApiProperty({ example: '****e-largo', description: '**** y los últimos 4 caracteres' })
  secret!: string;
}
