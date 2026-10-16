import { ConfigService } from '@nestjs/config';
import { ThrottlerModuleOptions } from '@nestjs/throttler';
import { ExecutionContext } from '@nestjs/common';
import {
  ES_LIMITE_ESTRICTO,
  ES_LIMITE_EVENTOS,
} from '../common/decorators/limite-peticiones.decorator';

/** Peticiones por IP y por ventana, en todo el servicio, si el entorno no dice otra cosa. */
export const LIMITE_POR_DEFECTO = 100;
export const VENTANA_POR_DEFECTO_SEGUNDOS = 60;

/** Nombre del contador de las rutas que piden un límite más estricto (ver @LimiteEstricto). */
export const LIMITADOR_ESTRICTO = 'estricto';

/** Nombre del contador de la API interna de eventos (ver @LimiteEventos). */
export const LIMITADOR_EVENTOS = 'eventos';

/** Publicaciones de eventos por minuto e IP si EVENTS_RATE_LIMIT_MAX no dice otra cosa. */
export const LIMITE_EVENTOS_POR_DEFECTO = 1200;

const marcada = (contexto: ExecutionContext, clave: string): boolean =>
  Boolean(
    Reflect.getMetadata(clave, contexto.getHandler()) ||
    Reflect.getMetadata(clave, contexto.getClass()),
  );

/**
 * Configuración del límite de peticiones:
 *
 * - `default`: un solo contador por IP para todo el servicio (no uno por ruta, que es lo que haría
 *   el generador de claves de @nestjs/throttler), con `RATE_LIMIT_MAX` y
 *   `RATE_LIMIT_WINDOW_SECONDS`.
 * - `estricto`: solo corre en las rutas marcadas con @LimiteEstricto y lleva un contador por
 *   ruta e IP, aparte del global. Su límite sale del decorador; los valores de aquí no se usan.
 * - `eventos`: solo corre en las rutas marcadas con @LimiteEventos (que no cuentan en el
 *   global): `EVENTS_RATE_LIMIT_MAX` por minuto e IP.
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
        skipIf: (contexto) => !marcada(contexto, ES_LIMITE_ESTRICTO),
      },
      {
        name: LIMITADOR_EVENTOS,
        limit: config.get<number>('EVENTS_RATE_LIMIT_MAX') ?? LIMITE_EVENTOS_POR_DEFECTO,
        ttl: 60_000,
        generateKey: (_contexto, ip, nombre) => `${nombre}:${ip}`,
        skipIf: (contexto) => !marcada(contexto, ES_LIMITE_EVENTOS),
      },
    ],
  };
}
