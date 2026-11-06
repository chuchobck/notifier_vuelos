/**
 * La topología de RabbitMQ que el notifier declara al conectar (assert: idempotente, así sobrevive
 * a un broker nuevo o con colas borradas). docs/EVENTOS.md y docs/DEPLOY.md la describen.
 *
 *   vuelos.eventos (topic, durable) --# --> notifier.eventos
 *   notifier.eventos.retry (TTL 30 s) --expira--> notifier.eventos   (por el exchange por defecto)
 *   notifier.eventos.dlq                                              (solo se llena y se revisa a mano)
 */
export const TOPOLOGIA = {
  exchange: 'vuelos.eventos',
  colaPrincipal: 'notifier.eventos',
  colaReintento: 'notifier.eventos.retry',
  colaMuertos: 'notifier.eventos.dlq',
  /** Cuánto espera un mensaje en la cola de reintento antes de volver a la principal. */
  esperaReintentoMs: 30_000,
} as const;

/** El `publicado_por` de lo que llega por AMQP (el de HTTP es el client_id del token del core). */
export const PUBLICADO_POR_AMQP = 'amqp:gateway';

/** Reglas del consumidor. */
export const REGLAS_AMQP = {
  /** Intentos en total por mensaje (el primero y sus reintentos); al agotarlos, a la DLQ. */
  maximoIntentos: 5,
  prefetchPorDefecto: 10,
  /** Espera antes de reconectar: crece al doble hasta el tope; con un 0 a 25 % de variación. */
  reconexionInicialMs: 1_000,
  reconexionMaximaMs: 30_000,
  /** Lo que se espera a los mensajes en curso al apagar. */
  plazoCierreMs: 5_000,
};

/** Por qué un mensaje fue a la DLQ: va en la cabecera `x-estado`. */
export type EstadoMuerto = 'JSON_INVALIDO' | 'SOBRE_INVALIDO' | 'CONFLICTO' | 'REINTENTOS_AGOTADOS';

export const CABECERAS_AMQP = {
  motivo: 'x-motivo',
  estado: 'x-estado',
  intentos: 'x-intentos',
  intentosPrevios: 'x-intentos-previos',
  routingKeyOriginal: 'x-routing-key-original',
  fecha: 'x-fecha-dlq',
  muertes: 'x-death',
  traceparent: 'traceparent',
} as const;
