import type { ConsumeMessage } from 'amqplib';

export type MensajeAmqp = ConsumeMessage;

export interface OpcionesPublicacionAmqp {
  messageId?: string;
  correlationId?: string;
  contentType?: string;
  headers: Record<string, unknown>;
}

/**
 * Lo mínimo que el consumidor usa de un canal AMQP. Existe para que las pruebas pongan un doble
 * sin broker; la implementación real es `FabricaAmqplib`.
 */
export interface CanalAmqp {
  declararExchange(nombre: string, tipo: 'topic'): Promise<void>;
  declararCola(nombre: string, argumentos?: Record<string, unknown>): Promise<void>;
  ligarCola(cola: string, exchange: string, patron: string): Promise<void>;
  prefetch(cantidad: number): Promise<void>;
  /** `null` llega si el broker cancela el consumo (se borró la cola). */
  consumir(cola: string, alRecibir: (mensaje: MensajeAmqp | null) => void): Promise<void>;
  ack(mensaje: MensajeAmqp): void;
  /** Publica en el exchange por defecto, directo a una cola, y espera la confirmación del broker. */
  publicarEnCola(cola: string, contenido: Buffer, opciones: OpcionesPublicacionAmqp): Promise<void>;
}

export interface ConexionAmqp {
  crearCanal(): Promise<CanalAmqp>;
  /** Avisa cuando la conexión o el canal se pierden. */
  alCerrar(escucha: (error?: Error) => void): void;
  cerrar(): Promise<void>;
}

/** Abre conexiones: es lo que las pruebas reemplazan. */
export abstract class FabricaAmqp {
  abstract conectar(url: string): Promise<ConexionAmqp>;
}
