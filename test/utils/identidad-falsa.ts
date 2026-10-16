import {
  createHash,
  createHmac,
  generateKeyPairSync,
  KeyObject,
  randomUUID,
  sign,
} from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { AUDIENCIA_PRUEBAS, EMISOR_PRUEBAS } from './entorno-pruebas';

/** El `aud` que emite identity_vuelos (el mismo para el core y para este servicio). */
export const AUDIENCIA = AUDIENCIA_PRUEBAS;

/** Una clave de firma RSA con su `kid` (huella RFC 7638, como identity_vuelos). */
export interface ClaveFalsa {
  kid: string;
  privada: KeyObject;
  publica: KeyObject;
  /** La clave pública en PEM (SPKI): lo que un atacante usaría como secreto HS256. */
  pem: string;
  jwk: { kty: 'RSA'; n: string; e: string; kid: string; alg: 'RS256'; use: 'sig' };
}

export interface OpcionesToken {
  sub?: unknown;
  scope?: unknown;
  /** client_id: solo los tokens de un cliente máquina a máquina lo llevan. */
  clientId?: unknown;
  iss?: unknown;
  aud?: unknown;
  /** Segundos desde el reloj de la prueba hasta `exp` (negativo: ya vencido). Por defecto 900. */
  venceEn?: number;
  /** Claims que el token no lleva (exp, iat, jti, sub...). */
  sin?: string[];
  /** Claims de más o que pisan los de arriba. */
  claims?: Record<string, unknown>;
  /** Cabecera: `kid` (null: sin kid), `typ` (null: sin typ) y `alg`. */
  kid?: string | null;
  typ?: string | null;
  alg?: string;
  /** Firma con otra clave (una que el JWKS no publica, o una ya quitada). */
  clave?: ClaveFalsa;
  /** Firma HS256 con este secreto en vez de RS256 (el ataque de confusión de algoritmo). */
  secretoHs256?: string | Buffer;
  /** Sin firma (alg none). */
  sinFirma?: boolean;
}

type Estado = 'arriba' | 'error' | 'lento';

const base64url = (datos: Buffer | string) => Buffer.from(datos).toString('base64url');

export function nuevaClave(): ClaveFalsa {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { n, e } = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  // RFC 7638: SHA-256 de los miembros obligatorios en orden lexicográfico, sin espacios
  const kid = base64url(
    createHash('sha256')
      .update(JSON.stringify({ e, kty: 'RSA', n }))
      .digest(),
  );
  return {
    kid,
    privada: privateKey,
    publica: publicKey,
    pem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    jwk: { kty: 'RSA', n, e, kid, alg: 'RS256', use: 'sig' },
  };
}

/**
 * Un servicio de identidad de mentira (copiado del core, fase 4b): publica un JWKS en
 * http://127.0.0.1:<puerto>/.well-known/jwks.json (con Cache-Control max-age) y firma tokens
 * como identity_vuelos (RS256, typ at+jwt, kid, iss EMISOR_PRUEBAS). Los tokens se arman a mano
 * con node:crypto, sin jose: así la prueba no comparte un error con el verificador, y puede
 * armar los que una librería no dejaría (alg none, HS256 con la clave pública, claims faltantes).
 *
 * Se puede rotar la clave, quitar una del JWKS, vaciarlo, hacer que responda 500, que tarde o
 * que se caiga (conexión rechazada), y cuenta las descargas del JWKS.
 */
export class IdentidadFalsa {
  /** Descargas del JWKS que llegaron (las de un servicio caído no llegan). */
  descargas = 0;
  /** Segundos del Cache-Control max-age del JWKS. */
  maxAge = 300;
  /** Toda clave que llegó a publicarse: las pruebas buscan su módulo en los logs. */
  readonly publicadas: ClaveFalsa[] = [];
  private claves: ClaveFalsa[] = [this.publicar(nuevaClave())];
  private estado: Estado = 'arriba';
  private demoraMs = 0;
  /** Respuestas lentas pendientes: se cancelan al caer, para no dejar timers vivos. */
  private readonly pendientes = new Set<NodeJS.Timeout>();

  private constructor(
    private servidor: Server,
    readonly puerto: number,
    private readonly ahora: () => Date,
  ) {}

  /** `ahora` es el reloj de la prueba: de él salen `iat` y `exp`. */
  static async iniciar(ahora: () => Date): Promise<IdentidadFalsa> {
    const servidor = createServer();
    await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
    const identidad = new IdentidadFalsa(servidor, (servidor.address() as AddressInfo).port, ahora);
    servidor.on('request', (p, r) => identidad.atender(p, r));
    return identidad;
  }

  /** El `iss` de sus tokens: fijo, el JWT_ISSUER del entorno de pruebas. */
  get emisor(): string {
    return EMISOR_PRUEBAS;
  }

  /** Donde publica el JWKS (crearApp apunta el verificador aquí). */
  get urlJwks(): string {
    return `http://127.0.0.1:${this.puerto}/.well-known/jwks.json`;
  }

  /** La clave con la que firma ahora (la última). */
  get claveActual(): ClaveFalsa {
    return this.claves[this.claves.length - 1];
  }

  /** Vuelve al estado inicial: una clave nueva, arriba, sin demora y sin descargas contadas. */
  async reiniciar(): Promise<void> {
    this.cancelarPendientes();
    await this.levantar();
    this.claves = [this.publicar(nuevaClave())];
    this.estado = 'arriba';
    this.demoraMs = 0;
    this.maxAge = 300;
    this.descargas = 0;
  }

  /** Publica una clave nueva y firma con ella desde ahora; la anterior sigue en el JWKS. */
  rotar(): ClaveFalsa {
    const nueva = this.publicar(nuevaClave());
    this.claves.push(nueva);
    return nueva;
  }

  /** Quita una clave del JWKS (por ejemplo, después de una filtración). */
  quitar(clave: ClaveFalsa): void {
    this.claves = this.claves.filter((c) => c.kid !== clave.kid);
  }

  /** El JWKS queda sin claves. */
  vaciar(): void {
    this.claves = [];
  }

  /** El JWKS responde 500. */
  fallar(): void {
    this.estado = 'error';
  }

  /** El JWKS tarda `ms` en responder. */
  tardar(ms: number): void {
    this.estado = 'lento';
    this.demoraMs = ms;
  }

  /** Deja de escuchar y corta las conexiones abiertas: conexión rechazada. */
  async caer(): Promise<void> {
    this.cancelarPendientes();
    if (!this.servidor.listening) return;
    await new Promise<void>((listo) => {
      this.servidor.close(() => listo());
      this.servidor.closeAllConnections();
    });
  }

  /** Vuelve a escuchar en el mismo puerto, con el JWKS de siempre. */
  async levantar(): Promise<void> {
    this.estado = 'arriba';
    if (this.servidor.listening) return;
    this.servidor = createServer((p, r) => this.atender(p, r));
    await new Promise<void>((listo) => this.servidor.listen(this.puerto, '127.0.0.1', listo));
  }

  async detener(): Promise<void> {
    await this.caer();
  }

  jwks(): { keys: ClaveFalsa['jwk'][] } {
    return { keys: this.claves.map((c) => c.jwk) };
  }

  /** Un token de acceso de una persona: sub (uuid nuevo si no se da) y scope (flights:webhooks). */
  firmar(opciones: OpcionesToken = {}): string {
    const segundos = Math.floor(this.ahora().getTime() / 1000);
    const clave = opciones.clave ?? this.claveActual;
    const claims: Record<string, unknown> = {
      iss: 'iss' in opciones ? opciones.iss : this.emisor,
      sub: 'sub' in opciones ? opciones.sub : randomUUID(),
      aud: 'aud' in opciones ? opciones.aud : AUDIENCIA,
      exp: segundos + (opciones.venceEn ?? 900),
      iat: segundos,
      jti: randomUUID(),
      scope: 'scope' in opciones ? opciones.scope : 'flights:webhooks',
      ...(opciones.clientId === undefined ? {} : { client_id: opciones.clientId }),
      ...opciones.claims,
    };
    for (const claim of opciones.sin ?? []) delete claims[claim];

    const alg =
      opciones.alg ?? (opciones.sinFirma ? 'none' : opciones.secretoHs256 ? 'HS256' : 'RS256');
    const cabecera: Record<string, unknown> = { alg };
    if (opciones.typ !== null) cabecera.typ = opciones.typ ?? 'at+jwt';
    if (opciones.kid !== null) cabecera.kid = opciones.kid ?? clave.kid;

    const cuerpo = `${base64url(JSON.stringify(cabecera))}.${base64url(JSON.stringify(claims))}`;
    if (opciones.sinFirma) return `${cuerpo}.`;
    if (opciones.secretoHs256 !== undefined) {
      return `${cuerpo}.${base64url(createHmac('sha256', opciones.secretoHs256).update(cuerpo).digest())}`;
    }
    return `${cuerpo}.${base64url(sign('sha256', Buffer.from(cuerpo), clave.privada))}`;
  }

  /** Un token de client_credentials: lleva client_id y su sub es el id del cliente. */
  firmarCliente(clientId: string, scope: string, opciones: OpcionesToken = {}): string {
    return this.firmar({ ...opciones, clientId, scope });
  }

  /** El token con el que publica el core: un cliente OAuth con events:publish. */
  firmarPublicador(opciones: OpcionesToken = {}): string {
    return this.firmarCliente('core-vuelos', 'events:publish', opciones);
  }

  private cancelarPendientes(): void {
    for (const pendiente of this.pendientes) clearTimeout(pendiente);
    this.pendientes.clear();
  }

  private publicar(clave: ClaveFalsa): ClaveFalsa {
    this.publicadas.push(clave);
    return clave;
  }

  private atender(peticion: IncomingMessage, respuesta: ServerResponse): void {
    if (peticion.url !== '/.well-known/jwks.json') {
      respuesta.writeHead(404).end();
      return;
    }
    this.descargas++;
    if (this.estado === 'error') {
      respuesta.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
      return;
    }
    const responder = () =>
      respuesta
        .writeHead(200, {
          'content-type': 'application/json',
          'cache-control': `public, max-age=${this.maxAge}`,
        })
        .end(JSON.stringify(this.jwks()));
    if (this.estado !== 'lento') {
      responder();
      return;
    }
    const pendiente = setTimeout(() => {
      this.pendientes.delete(pendiente);
      if (!respuesta.destroyed) responder();
    }, this.demoraMs);
    this.pendientes.add(pendiente);
  }
}
