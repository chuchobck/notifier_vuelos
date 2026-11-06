import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observabilidad } from '../../observabilidad/observabilidad';
import { CanalAmqp, ConexionAmqp, FabricaAmqp, MensajeAmqp } from './canal-amqp';
import { ProcesadorMensajes } from './procesador-mensajes';
import { REGLAS_AMQP, TOPOLOGIA } from './topologia';

export type EstadoConsumidor = 'apagado' | 'conectando' | 'conectado' | 'desconectado';

/**
 * El consumidor de RabbitMQ (fase 4b): el camino principal por el que llegan los eventos; POST
 * /internal/v1/events queda de respaldo. Con RABBITMQ_ENABLED=false (el valor por defecto) no hace
 * nada y el notifier funciona como antes.
 *
 * Nunca bloquea el arranque: conecta en segundo plano y, si el broker no está o se cae, reconecta
 * con espera creciente (de 1 s a 30 s). Al conectar declara la topología (ver TOPOLOGIA), así que
 * un broker nuevo o con colas borradas se repara solo. No se garantiza orden entre eventos: el
 * tercero ordena por occurredAt. Nunca se registra la URL del broker (lleva credenciales).
 */
@Injectable()
export class ConsumidorAmqp implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ConsumidorAmqp.name);
  private readonly habilitado: boolean;
  private readonly url: string | undefined;
  private readonly prefetch: number;
  private estadoActual: EstadoConsumidor = 'apagado';
  private conexion: ConexionAmqp | undefined;
  private temporizador: NodeJS.Timeout | undefined;
  private espera: number = REGLAS_AMQP.reconexionInicialMs;
  private cerrando = false;
  private readonly enCurso = new Set<Promise<void>>();

  constructor(
    private readonly fabrica: FabricaAmqp,
    private readonly procesador: ProcesadorMensajes,
    private readonly observabilidad: Observabilidad,
    config: ConfigService,
  ) {
    this.habilitado = config.get<string>('RABBITMQ_ENABLED') === 'true';
    this.url = config.get<string>('RABBITMQ_URL');
    this.prefetch = config.get<number>('RABBITMQ_PREFETCH') ?? REGLAS_AMQP.prefetchPorDefecto;
  }

  /** Solo informativo (lo lee quien quiera mirarlo): nada del servicio depende de esto. */
  estado(): EstadoConsumidor {
    return this.estadoActual;
  }

  onApplicationBootstrap(): void {
    if (!this.habilitado || !this.url) {
      this.logger.log('Apagado (RABBITMQ_ENABLED=false)');
      return;
    }
    this.observabilidad.notifier.amqpConectado.set(0);
    // En segundo plano: el arranque no espera al broker
    void this.conectar();
  }

  /** Un intento de conexión; si falla, programa el siguiente. */
  async conectar(): Promise<void> {
    if (this.cerrando || !this.url) return;
    this.cambiarEstado('conectando');
    let conexion: ConexionAmqp | undefined;
    try {
      conexion = await this.fabrica.conectar(this.url);
      const actual = conexion;
      let perdida = false;
      actual.alCerrar(() => {
        if (perdida) return;
        perdida = true;
        if (this.conexion === actual) this.conexion = undefined;
        this.perdioConexion('la conexión se cerró');
      });
      const canal = await actual.crearCanal();
      await this.declarar(canal);
      await canal.prefetch(this.prefetch);
      await canal.consumir(TOPOLOGIA.colaPrincipal, (mensaje) => this.alRecibir(canal, mensaje));
      if (this.cerrando) {
        await actual.cerrar();
        return;
      }
      this.conexion = actual;
      this.espera = REGLAS_AMQP.reconexionInicialMs;
      this.cambiarEstado('conectado');
    } catch (error) {
      // Solo la clase y el código: el mensaje de amqplib puede traer la URL con su clave
      const codigo = (error as NodeJS.ErrnoException)?.code;
      this.logger.warn(
        `No se pudo conectar a RabbitMQ (${error instanceof Error ? error.name : 'Error'}` +
          `${codigo ? ` ${codigo}` : ''})`,
      );
      if (conexion) await conexion.cerrar().catch(() => undefined);
      this.perdioConexion('falló el intento');
    }
  }

  /** La topología completa; repetirla es inocuo. */
  private async declarar(canal: CanalAmqp): Promise<void> {
    await canal.declararExchange(TOPOLOGIA.exchange, 'topic');
    await canal.declararCola(TOPOLOGIA.colaMuertos);
    // El mensaje expira y vuelve DIRECTO a la principal (exchange por defecto), no al exchange
    // vuelos.eventos: así no se repite en otras colas que otro servicio ligue a ese exchange.
    await canal.declararCola(TOPOLOGIA.colaReintento, {
      'x-message-ttl': TOPOLOGIA.esperaReintentoMs,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': TOPOLOGIA.colaPrincipal,
    });
    await canal.declararCola(TOPOLOGIA.colaPrincipal);
    await canal.ligarCola(TOPOLOGIA.colaPrincipal, TOPOLOGIA.exchange, '#');
  }

  private alRecibir(canal: CanalAmqp, mensaje: MensajeAmqp | null): void {
    if (mensaje === null) {
      // El broker canceló el consumo (se borró la cola): se vuelve a declarar al reconectar
      this.logger.warn('El broker canceló el consumo de la cola');
      void this.conexion?.cerrar();
      return;
    }
    const trabajo: Promise<void> = this.procesador
      .procesar(canal, mensaje)
      // Sin ack, el broker vuelve a entregar el mensaje al cerrarse el canal: nada se pierde
      .catch((error) =>
        this.logger.error(
          `Mensaje sin confirmar (${error instanceof Error ? error.name : 'Error'}): el broker lo reenviará`,
        ),
      )
      .finally(() => this.enCurso.delete(trabajo));
    this.enCurso.add(trabajo);
  }

  private perdioConexion(motivo: string): void {
    if (this.cerrando) return;
    this.cambiarEstado('desconectado');
    const variacion = 1 + Math.random() * 0.25;
    const demora = Math.round(this.espera * variacion);
    this.espera = Math.min(this.espera * 2, REGLAS_AMQP.reconexionMaximaMs);
    this.logger.warn(`RabbitMQ desconectado (${motivo}); se reintenta en ${demora} ms`);
    this.temporizador = setTimeout(() => void this.conectar(), demora);
    // No mantiene vivo el proceso
    this.temporizador.unref();
  }

  private cambiarEstado(estado: EstadoConsumidor): void {
    if (estado === this.estadoActual) return;
    this.estadoActual = estado;
    this.observabilidad.notifier.amqpConectado.set(estado === 'conectado' ? 1 : 0);
    this.logger.log(`Estado de RabbitMQ: ${estado}`);
  }

  async onModuleDestroy(): Promise<void> {
    this.cerrando = true;
    if (this.temporizador) clearTimeout(this.temporizador);
    if (!this.habilitado) return;
    // Deja terminar lo que está en curso (con tope) antes de cerrar el canal
    await Promise.race([
      Promise.allSettled([...this.enCurso]),
      new Promise((listo) => setTimeout(listo, REGLAS_AMQP.plazoCierreMs).unref()),
    ]);
    await this.conexion?.cerrar().catch(() => undefined);
    this.conexion = undefined;
    this.cambiarEstado('desconectado');
  }
}
