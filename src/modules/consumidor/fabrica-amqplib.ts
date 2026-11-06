import { Injectable } from '@nestjs/common';
import { connect } from 'amqplib';
import type { ConfirmChannel } from 'amqplib';
import { CanalAmqp, ConexionAmqp, FabricaAmqp, MensajeAmqp } from './canal-amqp';

/** Implementación real sobre amqplib: un canal con confirmaciones del broker. */
@Injectable()
export class FabricaAmqplib extends FabricaAmqp {
  async conectar(url: string): Promise<ConexionAmqp> {
    const conexion = await connect(url);
    // Sin escucha, un 'error' de la conexión tumbaría el proceso
    conexion.on('error', () => undefined);
    return {
      crearCanal: async () => canalDe(await conexion.createConfirmChannel()),
      alCerrar: (escucha) => {
        conexion.on('close', (error?: Error) => escucha(error));
      },
      cerrar: () => conexion.close().catch(() => undefined),
    };
  }
}

function canalDe(canal: ConfirmChannel): CanalAmqp {
  canal.on('error', () => undefined);
  return {
    declararExchange: async (nombre, tipo) => {
      await canal.assertExchange(nombre, tipo, { durable: true });
    },
    declararCola: async (nombre, argumentos) => {
      await canal.assertQueue(nombre, { durable: true, arguments: argumentos });
    },
    ligarCola: async (cola, exchange, patron) => {
      await canal.bindQueue(cola, exchange, patron);
    },
    prefetch: async (cantidad) => {
      await canal.prefetch(cantidad);
    },
    consumir: async (cola, alRecibir) => {
      await canal.consume(cola, (mensaje) => alRecibir(mensaje), { noAck: false });
    },
    ack: (mensaje: MensajeAmqp) => canal.ack(mensaje),
    publicarEnCola: (cola, contenido, opciones) =>
      new Promise<void>((resolver, rechazar) => {
        canal.sendToQueue(
          cola,
          contenido,
          {
            persistent: true,
            messageId: opciones.messageId,
            correlationId: opciones.correlationId,
            contentType: opciones.contentType,
            headers: opciones.headers,
          },
          (error) => (error ? rechazar(error as Error) : resolver()),
        );
      }),
  };
}
