import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * Un receptor real en 127.0.0.1 (el "tercero" de las pruebas): guarda lo que le llega y contesta
 * con `codigo`. Copiado del core (test/utils/receptor-webhook.ts).
 */
export class Receptor {
  recibidos: Array<{ ruta: string; cabeceras: IncomingHttpHeaders; cuerpo: string }> = [];
  codigo = 200;
  /** Cabeceras extra de la respuesta (por ejemplo Location, para probar una redirección). */
  cabecerasRespuesta: Record<string, string> = {};
  /** Si es true no contesta nunca (para probar el tiempo máximo). */
  mudo = false;
  private servidor: Server = createServer((req, res) => {
    const partes: Buffer[] = [];
    req.on('data', (p: Buffer) => partes.push(p));
    req.on('end', () => {
      this.recibidos.push({
        ruta: req.url ?? '',
        cabeceras: req.headers,
        cuerpo: Buffer.concat(partes).toString('utf8'),
      });
      if (this.mudo) return;
      res.writeHead(this.codigo, this.cabecerasRespuesta);
      res.end('recibido');
    });
  });

  async iniciar(): Promise<void> {
    await new Promise<void>((resolver) => this.servidor.listen(0, '127.0.0.1', resolver));
  }

  url(ruta: string): string {
    return `http://127.0.0.1:${(this.servidor.address() as AddressInfo).port}${ruta}`;
  }

  async detener(): Promise<void> {
    this.servidor.closeAllConnections();
    await new Promise((resolver) => this.servidor.close(resolver));
  }

  de(ruta: string) {
    return this.recibidos.filter((r) => r.ruta === ruta);
  }
}
