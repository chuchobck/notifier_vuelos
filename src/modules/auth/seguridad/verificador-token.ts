/** Lo que el guard saca de un token de acceso válido, lo haya emitido quien lo haya emitido. */
export interface IdentidadToken {
  /** usuario.id o cliente_oauth.id de identity; es el `id_propietario` de las suscripciones. */
  sub: string;
  scopes: string[];
  jti: string;
  /**
   * `client_id` del token, solo si lo emitió el servicio de identidad para un cliente máquina a
   * máquina (client_credentials). Los tokens de personas no lo llevan.
   */
  clienteId?: string;
}

export type MotivoTokenInvalido = 'expirado' | 'invalido';

/** El token no sirve. El guard lo convierte en 401; el motivo no lleva el token. */
export class TokenInvalidoError extends Error {
  constructor(readonly motivo: MotivoTokenInvalido) {
    super(motivo === 'expirado' ? 'The access token expired' : 'The access token is invalid');
    this.name = 'TokenInvalidoError';
  }
}

/**
 * Verifica un token de acceso. JwtAuthGuard depende solo de esta clase (abstracta: sirve de token
 * de inyección; las pruebas pueden reemplazarla). Es asíncrona porque una verificación puede
 * necesitar la red (bajar claves públicas).
 *
 * Un token que no sirve lanza TokenInvalidoError (401). Cualquier otro error sube tal cual.
 */
export abstract class VerificadorToken {
  abstract verificar(token: string): Promise<IdentidadToken>;
}
