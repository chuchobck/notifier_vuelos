import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Scope } from '../../modules/auth/scopes';
import { ApiProblema, DocumentarAutenticacion } from './documentacion.decorator';

export const SCOPES_REQUERIDOS = 'scopesRequeridos';
export const SOLO_CLIENTES = 'soloClientesOAuth';

/**
 * Scopes que debe traer el token para entrar a la ruta (todos los indicados). Sin ellos,
 * ScopesGuard responde 403 diciendo cuáles faltan. Implica JWT: no va junto con @Publico().
 *
 *   @Scopes('flights:webhooks')
 *   @Get()
 *   listar() {}
 *
 * También lo documenta en Swagger, con el candado de `bearer` y las respuestas 401 y 403.
 */
export const Scopes = (...scopes: [Scope, ...Scope[]]) =>
  applyDecorators(
    SetMetadata(SCOPES_REQUERIDOS, scopes),
    DocumentarAutenticacion(),
    ApiProblema(403, `El token no trae los scopes requeridos: ${scopes.join(', ')}`),
  );

/**
 * La ruta solo admite el token de un cliente OAuth (client_credentials: lleva `client_id`). El
 * token de una persona responde 403 aunque traiga los scopes. Va junto con @Scopes(...).
 */
export const SoloClientesOAuth = () =>
  applyDecorators(
    SetMetadata(SOLO_CLIENTES, true),
    ApiProblema(403, 'El token es de una persona: solo un cliente OAuth (client_credentials)'),
  );
