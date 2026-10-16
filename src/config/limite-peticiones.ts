import { ConfigService } from '@nestjs/config';
import { ThrottlerModuleOptions } from '@nestjs/throttler';
import { ES_LIMITE_ESTRICTO } from '../common/decorators/limite-peticiones.decorator';

/** Peticiones por IP y por ventana, en todo el servicio, si el entorno no dice otra cosa. */
export const LIMITE_POR_DEFECTO = 100;
export const VENTANA_POR_DEFECTO_SEGUNDOS = 60;

/** Nombre del contador de las rutas que piden un límite más estricto (ver @LimiteEstricto). */
export const LIMITADOR_ESTRICTO = 'estricto';

/**
 * Configuración del límite de peticiones:
 *
 * - `default`: un solo contador por IP para todo el servicio (no uno por ruta, que es lo que haría
 *   el generador de claves de @nestjs/throttler), con `RATE_LIMIT_MAX` y
 *   `RATE_LIMIT_WINDOW_SECONDS`.
 * - `estricto`: solo corre en las rutas marcadas con @LimiteEstricto y lleva un contador por
 *   ruta e IP, aparte del global. Su límite sale del decorador; los valores de aquí no se usan.
 */
export function opcionesLimitePeticiones(config: ConfigService): ThrottlerModuleOptions {
  const limite = config.get<number>('RATE_LIMIT_MAX') ?? LIMITE_POR_DEFECTO;
  const ventanaSegundos =
    config.get<number>('RATE_LIMIT_WINDOW_SECONDS') ?? VENTANA_POR_DEFECTO_SEGUNDOS;

  return {
    throttlers: [
      {
        name: 'default',
        limit: limite,
        ttl: ventanaSegundos * 1000,
        generateKey: (_contexto, ip, nombre) => `${nombre}:${ip}`,
      },
      {
        name: LIMITADOR_ESTRICTO,
        limit: limite,
        ttl: ventanaSegundos * 1000,
        skipIf: (contexto) =>
          !Reflect.getMetadata(ES_LIMITE_ESTRICTO, contexto.getHandler()) &&
          !Reflect.getMetadata(ES_LIMITE_ESTRICTO, contexto.getClass()),
      },
    ],
  };
}
