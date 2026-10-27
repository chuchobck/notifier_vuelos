import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { STATUS_CODES } from 'node:http';
import { CodigoError } from './codigo-error';
import { ParametroInvalido } from './error-negocio';

export const CONTENT_TYPE_PROBLEMA = 'application/problem+json';

/** Base de los `type` propios; la misma del core, para que los errores sean iguales a los de hoy. */
export const TIPO_ERROR_BASE = 'https://api.booking-hub.com/errors/';

/**
 * Cuerpo de todo error del servicio (RFC 9457). Es la misma forma que el ProblemDetails del
 * contrato del core (additionalProperties: false): no se agregan campos.
 */
export class ProblemDetails {
  @ApiProperty({ example: 'https://api.booking-hub.com/errors/validation-failed' })
  type!: string;

  @ApiProperty({ example: 'Unauthorized' })
  title!: string;

  @ApiProperty({ example: 401 })
  status!: number;

  @ApiPropertyOptional({ example: 'Invalid email or password' })
  detail?: string;

  @ApiProperty({
    enum: CodigoError,
    enumName: 'CodigoError',
    example: CodigoError.VALIDATION_FAILED,
  })
  code!: CodigoError;

  @ApiPropertyOptional({
    type: 'array',
    items: {
      type: 'object',
      properties: { name: { type: 'string' }, reason: { type: 'string' } },
    },
  })
  invalidParams?: ParametroInvalido[];
}

/** Descripción corta del status, como en RFC 9457 (`Not Found`, `Conflict`...). */
export function tituloDeStatus(status: number): string {
  return STATUS_CODES[status] ?? 'Error';
}

/** `RATE_LIMIT_EXCEEDED` → `https://api.booking-hub.com/errors/rate-limit-exceeded`. */
export function tipoDeCodigo(codigo: string): string {
  return TIPO_ERROR_BASE + codigo.toLowerCase().replace(/_/g, '-');
}
