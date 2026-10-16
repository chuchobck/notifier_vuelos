import { ConfigService } from '@nestjs/config';

/**
 * Quién emite los tokens de acceso que el servicio acepta: el servicio de identidad
 * (github.com/chuchobck/identity_vuelos). Este servicio no emite tokens: solo verifica los RS256
 * de identity con su JWKS, igual que el core con AUTH_MODE=external (fase 4b).
 */

/** Ruta del JWKS dentro del emisor (la que publica identity_vuelos). */
export const RUTA_JWKS = '/.well-known/jwks.json';

/** Lo que necesita la verificación, ya validado por entorno.ts. */
export interface ConfiguracionExterna {
  /** JWT_ISSUER: el `iss` exacto de los tokens (un origen, sin ruta). */
  emisor: string;
  /** JWT_AUDIENCE: el `aud` que deben traer. */
  audiencia: string;
  /** JWKS_URL, o {JWT_ISSUER}/.well-known/jwks.json. */
  urlJwks: string;
}

export function configuracionExterna(config: ConfigService): ConfiguracionExterna {
  const emisor = config.getOrThrow<string>('JWT_ISSUER');
  return {
    emisor,
    audiencia: config.getOrThrow<string>('JWT_AUDIENCE'),
    urlJwks: config.get<string>('JWKS_URL') || `${emisor}${RUTA_JWKS}`,
  };
}

/** Una URL http(s) sin usuario ni clave; con `exigirHttps`, solo https. */
function urlSegura(valor: string, exigirHttps: boolean): URL | undefined {
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    return undefined;
  }
  const protocolos = exigirHttps ? ['https:'] : ['https:', 'http:'];
  if (!protocolos.includes(url.protocol) || url.username !== '' || url.password !== '') {
    return undefined;
  }
  return url;
}

/**
 * El emisor es un origen tal cual (`https://identity.quinde.example`, con puerto si hace falta):
 * sin ruta, barra final, query ni fragmento, y escrito como lo normaliza la URL (minúsculas, sin
 * el puerto por defecto). Es el texto que se compara con el `iss` de cada token, y la base de
 * {JWT_ISSUER}/.well-known/jwks.json.
 */
export function esOrigenEmisor(valor: unknown, exigirHttps: boolean): boolean {
  if (typeof valor !== 'string') return false;
  const url = urlSegura(valor, exigirHttps);
  return url !== undefined && url.origin === valor;
}

/** JWKS_URL: una URL http(s) sin credenciales ni fragmento; https en producción. */
export function esUrlJwks(valor: unknown, exigirHttps: boolean): boolean {
  if (typeof valor !== 'string') return false;
  const url = urlSegura(valor, exigirHttps);
  return url !== undefined && url.hash === '';
}
