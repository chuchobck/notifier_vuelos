import { applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ESQUEMA_BEARER } from '../../config/swagger';
import { CONTENT_TYPE_PROBLEMA, ProblemDetails } from '../errores/problem-details';
import { ProblemDetailsV2 } from '../errores/problem-details-v2';

/** Respuesta de error documentada como `application/problem+json`. */
export function ApiProblema(status: number, descripcion: string) {
  return applyDecorators(
    ApiExtraModels(ProblemDetails),
    ApiResponse({
      status,
      description: descripcion,
      content: { [CONTENT_TYPE_PROBLEMA]: { schema: { $ref: getSchemaPath(ProblemDetails) } } },
    }),
  );
}

/** Respuesta de error del contrato v2 (ProblemDetails con instance, correlation_id y timestamp). */
export function ApiProblemaV2(status: number, descripcion: string) {
  return applyDecorators(
    ApiExtraModels(ProblemDetailsV2),
    ApiResponse({
      status,
      description: descripcion,
      content: { [CONTENT_TYPE_PROBLEMA]: { schema: { $ref: getSchemaPath(ProblemDetailsV2) } } },
    }),
  );
}

/** Lo mismo que DocumentarAutenticacion, con el ProblemDetails de v2 (rutas /api/v2). */
export function DocumentarAutenticacionV2() {
  return applyDecorators(
    ApiBearerAuth(ESQUEMA_BEARER),
    ApiProblemaV2(401, 'Falta el token, no es válido o venció (UNAUTHORIZED)'),
    ApiProblemaV2(403, 'Al token le falta el scope (FORBIDDEN)'),
    ApiProblemaV2(
      503,
      'No hay claves del servicio de identidad con las que verificar el token (PROVIDER_UNAVAILABLE)',
    ),
  );
}

/**
 * Solo documentación: la ruta exige un token (lo hace JwtAuthGuard, que es global, con o sin
 * este decorador). Swagger la muestra con candado y con su 401.
 */
export function DocumentarAutenticacion() {
  return applyDecorators(
    ApiBearerAuth(ESQUEMA_BEARER),
    ApiProblema(401, 'Falta el token, no es válido o venció'),
    ApiProblema(
      503,
      'No hay claves del servicio de identidad con las que verificar el token (AUTH_UNAVAILABLE)',
    ),
  );
}
