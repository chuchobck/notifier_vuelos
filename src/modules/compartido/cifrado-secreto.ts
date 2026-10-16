import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/**
 * Cifrado reversible del secreto de un webhook (hace falta en claro para firmar cada entrega).
 * AES-256-GCM con una clave de 32 bytes derivada con HKDF de WEBHOOK_SECRET_KEY; un nonce al
 * azar de 12 bytes por secreto. Se guarda `v1.<base64url(nonce | etiqueta | cifrado)>`. GCM
 * autentica: un valor alterado, o descifrado con otra clave, falla en vez de dar basura.
 *
 * Copiado tal cual del core (CifradoSecreto de backend_vuelos), con la MISMA sal
 * (`quinde-vuelos`) y la misma info (`webhook-secreto`) de HKDF: con la misma WEBHOOK_SECRET_KEY,
 * un secreto cifrado por el core se descifra aquí sin tocarlo (docs/MIGRACION.md). Cambiar la sal,
 * la info o el formato rompe esa migración.
 */
@Injectable()
export class CifradoSecreto {
  private readonly clave: Buffer;

  constructor(config: ConfigService) {
    this.clave = Buffer.from(
      hkdfSync(
        'sha256',
        config.getOrThrow<string>('WEBHOOK_SECRET_KEY'),
        'quinde-vuelos',
        'webhook-secreto',
        32,
      ),
    );
  }

  cifrar(secreto: string): string {
    const nonce = randomBytes(12);
    const cifrador = createCipheriv('aes-256-gcm', this.clave, nonce);
    const cifrado = Buffer.concat([cifrador.update(secreto, 'utf8'), cifrador.final()]);
    return `${VERSION}.${Buffer.concat([nonce, cifrador.getAuthTag(), cifrado]).toString('base64url')}`;
  }

  /** El secreto en claro; lanza si el valor no es de esta versión, fue alterado o la clave cambió. */
  descifrar(guardado: string): string {
    const [version, cuerpo] = guardado.split('.');
    if (version !== VERSION || !cuerpo) throw new Error('Secreto con un formato desconocido');
    const bytes = Buffer.from(cuerpo, 'base64url');
    const descifrador = createDecipheriv('aes-256-gcm', this.clave, bytes.subarray(0, 12));
    descifrador.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([descifrador.update(bytes.subarray(28)), descifrador.final()]).toString(
      'utf8',
    );
  }
}
