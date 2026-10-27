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
import { EVENTOS, TipoEvento } from '../../../compartido/eventos-webhook';
import { LARGO_MAXIMO_SECRETO, LARGO_MINIMO_SECRETO } from '../../dto/webhook.dto';

/**
 * components.schemas.WebhookSubscription del contrato de Vuelos v2 al registrar: url, events (los
 * 15 VuelosEventName) y secret, con las mismas reglas de validación que v1.
 */
export class SolicitudWebhookV2Dto {
  @ApiProperty({
    example: 'https://rda1-backend-integracion-sistemas.onrender.com/api/v2/webhooks/vuelos',
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
    enum: EVENTOS,
    enumName: 'VuelosEventName',
    isArray: true,
    minItems: 1,
    example: ['booking.confirmed', 'booking.ticket_issued', 'flight.status_changed'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EVENTOS.length)
  @ArrayUnique()
  @IsIn(EVENTOS, {
    each: true,
    message: `each value in $property must be one of: ${EVENTOS.join(', ')}`,
  })
  events!: TipoEvento[];

  @ApiProperty({
    minLength: LARGO_MINIMO_SECRETO,
    example: 'un-secreto-compartido-largo',
    description:
      'Con él se firma cada entrega (X-Webhook-Signature: sha256=<HMAC-SHA256 del cuerpo>). Se ' +
      'guarda cifrado y nunca se devuelve: las respuestas traen **** y sus últimos 4 caracteres',
  })
  @IsString()
  @MinLength(LARGO_MINIMO_SECRETO)
  @MaxLength(LARGO_MAXIMO_SECRETO)
  @Matches(/^\S+$/, { message: '$property must not contain spaces' })
  secret!: string;
}

/**
 * components.schemas.WebhookSubscription del contrato v2 al responder. Sin `secret`: en v2 es
 * `writeOnly` (y con minLength 16, que el enmascarado de v1 no cumple), así que no vuelve ni
 * enmascarado. v1 sigue devolviéndolo enmascarado, como el core.
 */
export class WebhookV2Dto {
  @ApiProperty({ format: 'uuid', readOnly: true })
  id!: string;

  @ApiProperty({ example: 'https://partner.example.com/hooks/vuelos', format: 'uri' })
  url!: string;

  @ApiProperty({ enum: EVENTOS, enumName: 'VuelosEventName', isArray: true })
  events!: TipoEvento[];

  @ApiProperty({ example: true, readOnly: true })
  active!: boolean;

  @ApiProperty({ format: 'date-time', readOnly: true })
  createdAt!: string;
}
