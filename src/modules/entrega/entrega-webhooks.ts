import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reloj } from '../../common/reloj';
import { CifradoSecreto } from '../compartido/cifrado-secreto';
import { firmar } from '../compartido/firma-webhook';
import { ClienteWebhook, ResultadoWebhook } from './cliente-webhook';
import { EntregaReclamada, EntregaRepository } from './entrega.repository';

/** Reglas del proceso periódico de entrega. */
export const REGLAS_ENTREGA = {
  /** Cada cuántos segundos corre si NOTIFIER_DELIVERY_JOB_INTERVAL_SECONDS no dice otra cosa. */
  intervaloPorDefectoSegundos: 10,
  /** Intentos en total por entrega (el primero y sus reintentos); el último fallido la deja FALLIDO. */
  maximoIntentos: 5,
  /** Minutos de espera tras el intento 1, 2, 3 y 4; tras el quinto no hay otro. */
  esperasMinutos: [1, 5, 30, 120],
  /** Lo que una entrega tomada queda apartada de otros procesos mientras se envía. */
  arrendamientoSegundos: 120,
  /** Entregas que se envían a la vez. */
  lote: 20,
  /** Entregas que atiende, como mucho, una corrida (lo que quede, en la siguiente). */
  maximoPorCorrida: 200,
  /** Entregas FALLIDO seguidas tras las que la suscripción se da de baja. */
  fallidasSeguidasParaBaja: 10,
};

/** Cuándo es el siguiente intento tras fallar el `intento`-ésimo, o null si ya no hay más. */
export function proximoIntentoTras(intento: number, ahora: Date): Date | null {
  if (intento >= REGLAS_ENTREGA.maximoIntentos) return null;
  const minutos = REGLAS_ENTREGA.esperasMinutos[intento - 1];
  return new Date(ahora.getTime() + minutos * 60_000);
}

export interface ResultadoEntregas {
  entregadas: number;
  reintentos: number;
  fallidas: number;
  /** Suscripciones dadas de baja por fallar siempre. */
  desactivadas: number;
}

/**
 * Proceso periódico que envía los webhooks de la bandeja de salida (entrega). Es EntregaWebhooks
 * del core con las mismas reglas: nunca corre dos veces a la vez en el mismo proceso, y entre
 * varias instancias cada entrega se toma con FOR UPDATE SKIP LOCKED y un arrendamiento, de modo
 * que el HTTP ocurre fuera de toda transacción y dos procesos no envían la misma.
 *
 * Cada envío lleva Content-Type, X-Webhook-Event, X-Webhook-Id (el eventId, para que el receptor
 * descarte duplicados: la entrega es "al menos una vez"), X-Webhook-Timestamp y
 * X-Webhook-Signature (sha256=HMAC de "timestamp.cuerpo" con el secreto de la suscripción). Un
 * 2xx cierra la entrega; cualquier otra cosa la reintenta con espera creciente y, al quinto
 * intento fallido, la deja FALLIDO. Si las últimas 10 entregas resueltas de una suscripción son
 * FALLIDO, se da de baja. Registra cada intento sin URL, secreto ni cuerpo.
 *
 * NOTIFIER_DELIVERY_JOB_ENABLED=false lo apaga (las pruebas lo apagan y llaman a `ejecutar`).
 */
@Injectable()
export class EntregaWebhooks implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EntregaWebhooks.name);
  private readonly habilitado: boolean;
  private readonly intervaloSegundos: number;
  private temporizador: NodeJS.Timeout | undefined;
  private corriendo: Promise<ResultadoEntregas> | undefined;

  constructor(
    private readonly entregas: EntregaRepository,
    private readonly cliente: ClienteWebhook,
    private readonly cifrado: CifradoSecreto,
    private readonly reloj: Reloj,
    config: ConfigService,
  ) {
    this.habilitado = config.get<string>('NOTIFIER_DELIVERY_JOB_ENABLED') !== 'false';
    this.intervaloSegundos =
      config.get<number>('NOTIFIER_DELIVERY_JOB_INTERVAL_SECONDS') ??
      REGLAS_ENTREGA.intervaloPorDefectoSegundos;
  }

  onApplicationBootstrap(): void {
    // Una línea al arrancar: en el log de cada instancia se ve qué procesos corren y cada cuánto
    if (!this.habilitado) {
      this.logger.log('Apagado (NOTIFIER_DELIVERY_JOB_ENABLED=false)');
      return;
    }
    this.temporizador = setInterval(() => void this.ejecutar(), this.intervaloSegundos * 1000);
    // No mantiene vivo el proceso: al cerrar la API no hay que esperar al siguiente tic.
    this.temporizador.unref();
    this.logger.log(`Activo: cada ${this.intervaloSegundos} s`);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.temporizador);
    await this.corriendo;
  }

  /**
   * Una corrida. Si ya hay una en curso, devuelve esa misma en vez de empezar otra. Un error
   * se registra y no detiene las corridas siguientes.
   */
  ejecutar(): Promise<ResultadoEntregas> {
    this.corriendo ??= this.corrida().finally(() => (this.corriendo = undefined));
    return this.corriendo;
  }

  private async corrida(): Promise<ResultadoEntregas> {
    const resultado: ResultadoEntregas = {
      entregadas: 0,
      reintentos: 0,
      fallidas: 0,
      desactivadas: 0,
    };
    let atendidas = 0;
    try {
      while (atendidas < REGLAS_ENTREGA.maximoPorCorrida) {
        const lote = await this.entregas.reclamar(
          this.reloj.ahora(),
          REGLAS_ENTREGA.lote,
          REGLAS_ENTREGA.arrendamientoSegundos,
        );
        if (lote.length === 0) break;
        atendidas += lote.length;
        const salidas = await Promise.allSettled(lote.map((e) => this.entregar(e)));
        salidas.forEach((salida, i) => {
          if (salida.status === 'rejected') {
            // Quedó apartada: vuelve a estar disponible cuando venza el arrendamiento
            this.logger.error(
              `Entrega ${lote[i].id} sin registrar: ${(salida.reason as Error).name}`,
            );
            return;
          }
          const { estado, desactivada } = salida.value;
          if (estado === 'ENTREGADO') resultado.entregadas++;
          else if (estado === 'FALLIDO') resultado.fallidas++;
          else if (estado === 'PENDIENTE') resultado.reintentos++;
          if (desactivada) resultado.desactivadas++;
        });
      }
    } catch (error) {
      this.logger.error(`Falló la entrega de webhooks: ${(error as Error).name}`);
    }
    return resultado;
  }

  private async entregar(
    e: EntregaReclamada,
  ): Promise<{ estado: string | null; desactivada: boolean }> {
    const envio = await this.enviar(e);
    const ahora = this.reloj.ahora();
    const exito = envio.codigoHttp !== null && envio.codigoHttp >= 200 && envio.codigoHttp < 300;
    // Una suscripción dada de baja ya no recibe nada: no hay reintento
    const proximo = exito || !e.suscripcionActiva ? null : proximoIntentoTras(e.intentos, ahora);
    const estado = await this.entregas.registrarResultado(e.id, e.intentos, ahora, envio, proximo);
    this.logger.log(
      `Entrega ${e.id} (${e.tipo}) intento ${e.intentos}/${REGLAS_ENTREGA.maximoIntentos}: ` +
        `${estado ?? 'NO_APLICADA'} ${envio.codigoHttp ?? envio.error}`,
    );
    let desactivada = false;
    if (estado === 'FALLIDO' && e.suscripcionActiva) {
      desactivada = await this.entregas.desactivarSiSoloFalla(
        e.suscripcionId,
        REGLAS_ENTREGA.fallidasSeguidasParaBaja,
        ahora,
      );
      if (desactivada) {
        this.logger.warn(
          `Suscripción ${e.suscripcionId} dada de baja: ${REGLAS_ENTREGA.fallidasSeguidasParaBaja} entregas FALLIDO seguidas`,
        );
      }
    }
    return { estado, desactivada };
  }

  /** El POST firmado; nunca lanza: un error es un resultado con su código. */
  private async enviar(e: EntregaReclamada): Promise<ResultadoWebhook> {
    if (!e.suscripcionActiva) return { codigoHttp: null, error: 'SUBSCRIPTION_INACTIVE' };
    let secreto: string;
    try {
      secreto = this.cifrado.descifrar(e.secretoCifrado);
    } catch {
      return { codigoHttp: null, error: 'SECRET_UNREADABLE' };
    }
    const cuerpo = JSON.stringify(e.cuerpo);
    const timestamp = Math.floor(this.reloj.ahora().getTime() / 1000);
    try {
      return await this.cliente.enviar({
        url: e.url,
        cuerpo,
        cabeceras: {
          'Content-Type': 'application/json',
          'X-Webhook-Event': e.tipo,
          'X-Webhook-Id': e.eventId,
          'X-Webhook-Timestamp': String(timestamp),
          'X-Webhook-Signature': firmar(secreto, timestamp, cuerpo),
        },
      });
    } catch {
      return { codigoHttp: null, error: 'NETWORK_ERROR' };
    }
  }
}
