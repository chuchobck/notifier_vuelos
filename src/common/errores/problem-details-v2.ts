import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ParametroInvalido } from './error-negocio';
import { ProblemDetails, tipoDeCodigo } from './problem-details';

/**
 * Lista cerrada de `code` del ProblemDetails del contrato de Vuelos v2
 * (components.schemas.ProblemDetails.code en contracts/vuelos-openapi-v2.yaml del core), copiada
 * de src/common/errores/codigo-error-v2.ts del core. Si el contrato cambia, cambia con él.
 */
export enum CodigoErrorV2 {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  OFFER_NO_LONGER_AVAILABLE = 'OFFER_NO_LONGER_AVAILABLE',
  HOLD_EXPIRED = 'HOLD_EXPIRED',
  HOLD_ALREADY_CONSUMED = 'HOLD_ALREADY_CONSUMED',
  SEAT_TAKEN = 'SEAT_TAKEN',
  SEAT_CABIN_MISMATCH = 'SEAT_CABIN_MISMATCH',
  INFANT_SEAT_NOT_ALLOWED = 'INFANT_SEAT_NOT_ALLOWED',
  INFANT_WITHOUT_ADULT = 'INFANT_WITHOUT_ADULT',
  PASSENGER_COUNT_MISMATCH = 'PASSENGER_COUNT_MISMATCH',
  DOCUMENT_EXPIRED = 'DOCUMENT_EXPIRED',
  PASSPORT_REQUIRED_INTERNATIONAL = 'PASSPORT_REQUIRED_INTERNATIONAL',
  PAYMENT_REFERENCE_INVALID = 'PAYMENT_REFERENCE_INVALID',
  PAYMENT_NOT_AUTHORIZED = 'PAYMENT_NOT_AUTHORIZED',
  AMOUNT_MISMATCH = 'AMOUNT_MISMATCH',
  PNR_CREATION_FAILED = 'PNR_CREATION_FAILED',
  BOOKING_NOT_CONFIRMED = 'BOOKING_NOT_CONFIRMED',
  TICKET_ISSUANCE_FAILED = 'TICKET_ISSUANCE_FAILED',
  TICKET_ALREADY_ISSUED = 'TICKET_ALREADY_ISSUED',
  BAGGAGE_LIMIT_EXCEEDED = 'BAGGAGE_LIMIT_EXCEEDED',
  FARE_NOT_CHANGEABLE = 'FARE_NOT_CHANGEABLE',
  CHANGE_OFFER_EXPIRED = 'CHANGE_OFFER_EXPIRED',
  QUOTE_EXPIRED = 'QUOTE_EXPIRED',
  ALREADY_CANCELLED = 'ALREADY_CANCELLED',
  BOOKING_NOT_CANCELLABLE = 'BOOKING_NOT_CANCELLABLE',
  CUTOFF_PASSED = 'CUTOFF_PASSED',
  CHECK_IN_NOT_AVAILABLE = 'CHECK_IN_NOT_AVAILABLE',
  CHECK_IN_FAILED = 'CHECK_IN_FAILED',
  BOARDING_PASS_NOT_AVAILABLE = 'BOARDING_PASS_NOT_AVAILABLE',
  FLIGHT_ALREADY_DEPARTED = 'FLIGHT_ALREADY_DEPARTED',
  FLIGHT_CANCELLED = 'FLIGHT_CANCELLED',
  FLIGHT_STATUS_NOT_AVAILABLE = 'FLIGHT_STATUS_NOT_AVAILABLE',
  INVALID_STATUS_TRANSITION = 'INVALID_STATUS_TRANSITION',
  PROMOTION_DISCOUNT_OUT_OF_RANGE = 'PROMOTION_DISCOUNT_OUT_OF_RANGE',
}

/** Los `code` de v1 que también existen en v2 (VALIDATION_FAILED, RATE_LIMIT_EXCEEDED). */
const DE_V1: ReadonlySet<string> = new Set(Object.values(CodigoErrorV2));

/**
 * El `code` v2 de un error: el genérico de su status cuando v1 no tenía uno (v1 usa
 * VALIDATION_FAILED para 401, 403, 404 y 5xx, y AUTH_UNAVAILABLE para identity sin claves) y, si
 * no, el mismo de v1. Es la regla del core (`codigoV2PorDefecto`).
 */
export function codigoV2PorDefecto(status: number, codigo: string): CodigoErrorV2 {
  if (status === 401) return CodigoErrorV2.UNAUTHORIZED;
  if (status === 403) return CodigoErrorV2.FORBIDDEN;
  if (status === 404) return CodigoErrorV2.NOT_FOUND;
  if (status === 503 || status === 504) return CodigoErrorV2.PROVIDER_UNAVAILABLE;
  if (status >= 500) return CodigoErrorV2.INTERNAL_ERROR;
  return DE_V1.has(codigo) ? (codigo as CodigoErrorV2) : CodigoErrorV2.VALIDATION_FAILED;
}

/** Las rutas que responden con el ProblemDetails de v2. */
export const PREFIJO_RUTAS_V2 = '/api/v2/';

/** ProblemDetails del contrato v2: el de v1 más `instance`, `correlation_id` y `timestamp`. */
export class ProblemDetailsV2 {
  @ApiProperty({ example: 'https://api.booking-hub.com/errors/not-found' })
  type!: string;

  @ApiProperty({ example: 'Not Found' })
  title!: string;

  @ApiProperty({ example: 404 })
  status!: number;

  @ApiPropertyOptional({ example: 'Webhook 7c9e6679-7425-40de-944b-e07fc1f90ae7 was not found' })
  detail?: string;

  @ApiProperty({ example: '/api/v2/vuelos/webhooks/7c9e6679-7425-40de-944b-e07fc1f90ae7' })
  instance!: string;

  @ApiProperty({ enum: CodigoErrorV2, enumName: 'CodigoErrorV2', example: CodigoErrorV2.NOT_FOUND })
  code!: CodigoErrorV2;

  @ApiProperty({ example: 'corr-vuelos-7f3a9c' })
  correlation_id!: string;

  @ApiProperty({ format: 'date-time', example: '2026-10-23T10:16:02.000Z' })
  timestamp!: string;

  @ApiPropertyOptional({
    type: 'array',
    items: {
      type: 'object',
      properties: { name: { type: 'string' }, reason: { type: 'string' } },
    },
  })
  invalidParams?: ParametroInvalido[];
}

/**
 * El ProblemDetails de v1 llevado al de v2 (§11 del contrato): `code` del enum de v2 (y su `type`),
 * `instance` = la ruta pedida sin la query, `correlation_id` = el X-Correlation-Id de la petición y
 * `timestamp` = la hora del error. Sin campos de más (el esquema es additionalProperties: false).
 */
export function aProblemDetailsV2(
  problema: ProblemDetails,
  instancia: string,
  correlationId: string,
  ahora: Date,
): ProblemDetailsV2 {
  const code = codigoV2PorDefecto(problema.status, problema.code);
  return {
    type: tipoDeCodigo(code),
    title: problema.title,
    status: problema.status,
    ...(problema.detail === undefined ? {} : { detail: problema.detail }),
    instance: instancia,
    code,
    correlation_id: correlationId,
    timestamp: ahora.toISOString(),
    ...(problema.invalidParams === undefined ? {} : { invalidParams: problema.invalidParams }),
  };
}
