import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup, LookupAddress } from 'node:dns';
import { request as pedirHttp } from 'node:http';
import { request as pedirHttps } from 'node:https';
import { isIP, LookupFunction } from 'node:net';
import { ClienteWebhook, PeticionWebhook, ResultadoWebhook } from './cliente-webhook';
import { direccionProhibida } from '../compartido/destino-permitido';

export const REGLAS_ENVIO = {
  /** Tiempo máximo de todo el envío (conectar, enviar y recibir la respuesta). */
  tiempoMaximoMs: 5_000,
};

/**
 * El envío real. Cada entrega vuelve a comprobar el destino (SSRF) sobre la dirección a la que
 * de verdad se conecta: la resolución de DNS se hace aquí, en `lookup`, y se rechaza antes de
 * abrir el socket, así un nombre que apuntaba a una IP pública al registrar y ahora a una
 * interna (DNS rebinding) no llega a la red. No sigue redirecciones (una 3xx es un fallo: podría
 * llevar a una dirección interna), corta a los 5 s y descarta el cuerpo de la respuesta.
 */
@Injectable()
export class ClienteWebhookHttp extends ClienteWebhook {
  private readonly produccion: boolean;

  constructor(config: ConfigService) {
    super();
    this.produccion = config.get<string>('NODE_ENV') === 'production';
  }

  enviar({ url, cabeceras, cuerpo }: PeticionWebhook): Promise<ResultadoWebhook> {
    return new Promise((resolver) => {
      let destino: URL;
      try {
        destino = new URL(url);
      } catch {
        return resolver({ codigoHttp: null, error: 'INVALID_URL' });
      }
      const seguro = destino.protocol === 'https:';
      if (!seguro && (destino.protocol !== 'http:' || this.produccion)) {
        return resolver({ codigoHttp: null, error: 'INSECURE_URL' });
      }
      const host = destino.hostname.replace(/^\[|\]$/g, '');
      // Una IP literal no pasa por lookup: se juzga aquí
      if (isIP(host) !== 0 && direccionProhibida(host, { produccion: this.produccion })) {
        return resolver({ codigoHttp: null, error: 'DESTINATION_NOT_ALLOWED' });
      }
      const pedir = seguro ? pedirHttps : pedirHttp;
      const peticion = pedir(
        destino,
        {
          method: 'POST',
          headers: { ...cabeceras, 'Content-Length': Buffer.byteLength(cuerpo) },
          lookup: this.resolverSeguro,
          agent: false,
          signal: AbortSignal.timeout(REGLAS_ENVIO.tiempoMaximoMs),
        },
        (respuesta) => {
          respuesta.resume();
          respuesta.on('end', () =>
            resolver({ codigoHttp: respuesta.statusCode ?? null, error: null }),
          );
          respuesta.on('error', (e) => resolver({ codigoHttp: null, error: codigoDeError(e) }));
        },
      );
      peticion.on('error', (e) => resolver({ codigoHttp: null, error: codigoDeError(e) }));
      peticion.end(cuerpo);
    });
  }

  /** dns.lookup que descarta el destino si alguna de sus direcciones no está permitida. */
  private readonly resolverSeguro: LookupFunction = (host, opciones, devolver) => {
    lookup(host, { ...opciones, all: true }, (error, direcciones) => {
      if (error) return devolver(error, '', 4);
      const lista = direcciones as LookupAddress[];
      if (lista.some((d) => direccionProhibida(d.address, { produccion: this.produccion }))) {
        const rechazo = Object.assign(new Error('destino no permitido'), {
          code: 'DESTINATION_NOT_ALLOWED',
        });
        return devolver(rechazo, '', 4);
      }
      if (opciones.all) {
        (devolver as unknown as (e: null, d: LookupAddress[]) => void)(null, lista);
      } else {
        devolver(null, lista[0].address, lista[0].family);
      }
    });
  };
}

/** Un código corto del error de red; nada del mensaje, que trae host y puerto. */
function codigoDeError(error: Error): string {
  const { code, name } = error as Error & { code?: string };
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ABORT_ERR') return 'TIMEOUT';
  return typeof code === 'string' && /^[A-Z0-9_]{3,40}$/.test(code) ? code : 'NETWORK_ERROR';
}
