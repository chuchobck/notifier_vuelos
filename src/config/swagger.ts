import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export const RUTA_SWAGGER = 'api/docs';
/** Versión del servicio (la de package.json). */
export const VERSION_SERVICIO = '0.1.0';
const TITULO = 'Quinde · Notifier';

/** Nombre del esquema bearer de Swagger (el del botón Authorize). */
export const ESQUEMA_BEARER = 'bearer';

/** Etiquetas de Swagger, en el orden en que se muestran. `Webhooks` es la del contrato del core. */
export const ETIQUETAS = {
  webhooks: 'Webhooks',
  eventos: 'Eventos internos',
  salud: 'Salud',
} as const;

const DESCRIPCIONES: Record<keyof typeof ETIQUETAS, string> = {
  webhooks:
    'Suscripciones a webhooks del usuario del token, idénticas a /webhooks del contrato GDS Flight Core API 1.5.0.0 (scope flights:webhooks).',
  eventos:
    'Por donde el core publica sus eventos (scope events:publish, solo clientes OAuth). Contrato del sobre: contracts/events/ y contracts/asyncapi.yaml.',
  salud: 'Chequeo de vida y de disponibilidad.',
};

/**
 * El documento OpenAPI del servicio. Es determinista (no depende del entorno ni de la hora):
 * así se puede exportar a contracts/notifier-openapi.json y comparar en una prueba.
 */
export function crearDocumentoOpenApi(app: INestApplication): OpenAPIObject {
  const constructor = new DocumentBuilder()
    .setTitle(TITULO)
    .setDescription(
      'Suscripciones a webhooks y entrega firmada de los eventos del sistema de vuelos Quinde. ' +
        'Verifica los tokens RS256 de identity_vuelos por su JWKS.',
    )
    .setVersion(VERSION_SERVICIO)
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Token de acceso de identity_vuelos: el de una persona (/identity/v1/auth/login) o el ' +
          'de un cliente OAuth (/oauth2/token, client_credentials)',
      },
      ESQUEMA_BEARER,
    );

  for (const [clave, nombre] of Object.entries(ETIQUETAS)) {
    constructor.addTag(nombre, DESCRIPCIONES[clave as keyof typeof ETIQUETAS]);
  }
  return SwaggerModule.createDocument(app, constructor.build());
}

/** Swagger UI en /api/docs y el OpenAPI en JSON en /api/docs-json. */
export function configurarSwagger(app: INestApplication): void {
  SwaggerModule.setup(RUTA_SWAGGER, app, crearDocumentoOpenApi(app), {
    customSiteTitle: TITULO,
    swaggerOptions: { persistAuthorization: true },
  });
}
