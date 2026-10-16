import { Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { CryptoKey, decodeProtectedHeader, errors, JWTHeaderParameters, jwtVerify } from 'jose';
import { Reloj } from '../../../common/reloj';
import { ConfiguracionExterna } from '../../../config/autenticacion';
import { SCOPES } from '../scopes';
import { ClavesJwks, FORMATO_KID, JwksNoDisponibleError } from './claves-jwks';
import {
  IdentidadToken,
  MotivoTokenInvalido,
  TokenInvalidoError,
  VerificadorToken,
} from './verificador-token';

/** Único algoritmo aceptado, fijado aquí: nunca se lee del token (ni `none` ni HS256). */
export const ALGORITMO_EXTERNO = 'RS256';

/** `typ` de un token de acceso JWT (RFC 9068, sección 2.1). */
export const TIPO_TOKEN_ACCESO = 'at+jwt';

/**
 * Diferencia de reloj tolerada con el servicio de identidad al mirar `exp` (y `nbf` si viene).
 * Pequeña a propósito: un token vencido vale a lo sumo 30 s más, y los dos servicios sincronizan
 * su hora (NTP).
 */
export const TOLERANCIA_RELOJ_SEGUNDOS = 30;

/** `client_id` de un cliente OAuth: lo que admite identity_vuelos (ck_cliente_oauth_codigo). */
const FORMATO_CLIENT_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/** Un scope que se puede escribir en el log sin riesgo. */
const FORMATO_SCOPE_SEGURO = /^[A-Za-z0-9:._-]{1,64}$/;

const SCOPES_CONOCIDOS: ReadonlySet<string> = new Set(SCOPES);

/**
 * Verifica los tokens del servicio de identidad con su JWKS (copiado del core, fase 4b): RS256 con la
 * clave de su `kid`, cabecera `typ` at+jwt, `iss` igual a JWT_ISSUER (texto a texto), `aud` con
 * JWT_AUDIENCE, y `exp`, `iat`, `jti` y `sub` presentes; `exp` con 30 s de tolerancia. Además:
 * `sub` uuid, `scope` texto y, si viene, `client_id` (token de un cliente máquina a máquina).
 *
 * Los scopes salen del token: el servicio no los recalcula. Uno que no conoce
 * (src/modules/auth/scopes.ts) se ignora y se avisa en el log.
 *
 * Un rechazo deja en el log el `kid` y el motivo, nunca el token.
 */
export class VerificadorJwks extends VerificadorToken {
  private readonly logger = new Logger('Autenticacion');
  private readonly scopesAvisados = new Set<string>();

  constructor(
    private readonly claves: ClavesJwks,
    private readonly config: ConfiguracionExterna,
    private readonly reloj: Reloj,
  ) {
    super();
  }

  async verificar(token: string): Promise<IdentidadToken> {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, (cabecera) => this.claveDe(cabecera), {
        algorithms: [ALGORITMO_EXTERNO],
        typ: TIPO_TOKEN_ACCESO,
        issuer: this.config.emisor,
        audience: this.config.audiencia,
        requiredClaims: ['exp', 'iat', 'jti', 'sub'],
        clockTolerance: TOLERANCIA_RELOJ_SEGUNDOS,
        currentDate: this.reloj.ahora(),
      }));
    } catch (error) {
      if (error instanceof JwksNoDisponibleError) throw error;
      throw this.rechazar(token, motivoDeJose(error));
    }

    const { sub, scope, jti, client_id: clientId } = payload;
    if (typeof sub !== 'string' || !isUUID(sub)) throw this.rechazar(token, 'sub-no-uuid');
    if (typeof scope !== 'string') throw this.rechazar(token, 'scope-no-texto');
    if (typeof jti !== 'string' || jti === '') throw this.rechazar(token, 'jti-invalido');
    if (
      clientId !== undefined &&
      (typeof clientId !== 'string' || !FORMATO_CLIENT_ID.test(clientId))
    ) {
      throw this.rechazar(token, 'client_id-invalido');
    }

    return {
      sub,
      scopes: this.scopesConocidos(scope),
      jti,
      ...(typeof clientId === 'string' ? { clienteId: clientId } : {}),
    };
  }

  /** Sin `kid`, o con uno que el JWKS no tiene, no hay con qué verificar: 401. */
  private async claveDe(cabecera: JWTHeaderParameters): Promise<CryptoKey> {
    const kid = cabecera.kid;
    if (typeof kid !== 'string' || !FORMATO_KID.test(kid)) throw new errors.JWKSNoMatchingKey();
    const clave = await this.claves.clave(kid);
    if (clave === undefined) throw new errors.JWKSNoMatchingKey();
    return clave;
  }

  private scopesConocidos(scope: string): string[] {
    const pedidos = scope.split(' ').filter((s) => s !== '');
    for (const desconocido of pedidos.filter((s) => !SCOPES_CONOCIDOS.has(s))) {
      if (this.scopesAvisados.has(desconocido)) continue;
      this.scopesAvisados.add(desconocido);
      const nombre = FORMATO_SCOPE_SEGURO.test(desconocido) ? desconocido : '(no imprimible)';
      this.logger.warn(
        `Scope desconocido en un token del servicio de identidad: ${nombre} (se ignora)`,
      );
    }
    return SCOPES.filter((s) => pedidos.includes(s));
  }

  private rechazar(token: string, motivo: string): TokenInvalidoError {
    const kid = kidLegible(token);
    const linea = `Token rechazado: ${motivo} (kid ${kid})`;
    if (motivo === 'expirado') this.logger.debug(linea);
    else this.logger.warn(linea);
    const tipo: MotivoTokenInvalido = motivo === 'expirado' ? 'expirado' : 'invalido';
    return new TokenInvalidoError(tipo);
  }
}

/** El `kid` de la cabecera si se puede leer y es seguro escribirlo en el log. */
function kidLegible(token: string): string {
  try {
    const { kid } = decodeProtectedHeader(token);
    return typeof kid === 'string' && FORMATO_KID.test(kid) ? kid : '-';
  } catch {
    return '-';
  }
}

/** Un motivo corto y fijo por cada error de jose (alg-no-permitido, iss-check_failed...). */
function motivoDeJose(error: unknown): string {
  if (error instanceof errors.JWTExpired) return 'expirado';
  if (error instanceof errors.JWTClaimValidationFailed) return `${error.claim}-${error.reason}`;
  if (error instanceof errors.JOSEAlgNotAllowed) return 'alg-no-permitido';
  if (error instanceof errors.JWKSNoMatchingKey) return 'kid-desconocido';
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'firma-invalida';
  if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid) {
    return 'formato-invalido';
  }
  return 'invalido';
}
