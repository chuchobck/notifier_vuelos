import { SetMetadata, applyDecorators } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';

export const ES_LIMITE_ESTRICTO = 'esLimiteEstricto';

/**
 * Límite propio para una ruta (o un controller), más bajo que el global. Cuenta por IP y por
 * ruta, aparte del contador global: la petición debe pasar los dos.
 *
 *   @LimiteEstricto(5, 60)   // 5 peticiones por minuto
 *   @Post()
 *   registrar() {}
 *
 * Lo usa POST /flights/v1/webhooks (cada alta resuelve DNS). Al pasarse, responde
 * 429 RATE_LIMIT_EXCEEDED con `Retry-After`.
 */
export function LimiteEstricto(limite: number, ventanaSegundos: number) {
  return applyDecorators(
    SetMetadata(ES_LIMITE_ESTRICTO, true),
    // El nombre debe ser el mismo que el del limitador en opcionesLimitePeticiones().
    Throttle({ estricto: { limit: limite, ttl: ventanaSegundos * 1000 } }),
  );
}

/** Excluye una ruta del límite de peticiones (los chequeos de salud del orquestador). */
export const SinLimiteDePeticiones = () => SkipThrottle({ default: true, estricto: true });
