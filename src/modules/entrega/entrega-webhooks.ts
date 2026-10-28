import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Span, SpanKind } from '@opentelemetry/api';
import { CABECERA_CORRELACION, conCorrelacion } from '../../common/contexto/correlation-id';
import { Reloj } from '../../common/reloj';
import { contextoDeTraceparent } from '../../observabilidad/contexto-traza';
import { ResultadoEntregaMetrica } from '../../observabilidad/metricas-notifier';
import { Observabilidad } from '../../observabilidad/observabilidad';
import { marcarError } from '../../observabilidad/trazas';
import { CifradoSecreto } from '../compartido/cifrado-secreto';
import { cabecerasDeFirmaV2 } from '../compartido/firma-cloudevents';
import { firmar } from '../compartido/firma-webhook';
import { CONTENT_TYPE_CLOUDEVENTS } from '../evento/traductores/cloudevent.v2';
import { FormatoEntrega } from '../evento/traductores/evento-interno';
import { ClienteWebhook, ResultadoWebhook } from './cliente-webhook';
import { EntregaReclamada, EntregaRepository } from './entrega.repository';

/** Reglas del proceso periódico de entrega (las del core; los reintentos, los de una suscripción v1). */
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

/**
 * Los reintentos de una suscripción v2: los del contrato de Vuelos v2 (createWebhook: "1 min,
 * 5 min, 30 min, 2 h, 6 h hasta recibir 2xx"), 6 intentos en total. Lo que se agote sigue en el
 * feed GET /api/v2/vuelos/eventos.
 */
export const REGLAS_ENTREGA_V2 = {
  maximoIntentos: 6,
  esperasMinutos: [1, 5, 30, 120, 360],
};

/** Las reglas de reintento de un formato. */
function reintentosDe(formato: FormatoEntrega): {
  maximoIntentos: number;
  esperasMinutos: number[];
} {
  return formato === 'v2' ? REGLAS_ENTREGA_V2 : REGLAS_ENTREGA;
}

/** Cuándo es el siguiente intento tras fallar el `intento`-ésimo, o null si ya no hay más. */
export function proximoIntentoTras(
  intento: number,
  ahora: Date,
  formato: FormatoEntrega = 'v1',
): Date | null {
  const reglas = reintentosDe(formato);
  if (intento >= reglas.maximoIntentos) return null;
  const minutos = reglas.esperasMinutos[intento - 1];
  return new Date(ahora.getTime() + minutos * 60_000);
}

/** El estado en que quedó un intento → la etiqueta `result` de notifier_deliveries_total. */
const RESULTADO_METRICA: Record<string, ResultadoEntregaMetrica> = {
  ENTREGADO: 'delivered',
  PENDIENTE: 'retry',
  FALLIDO: 'failed',
};

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
 * Las cabeceras dependen del formato de la suscripción (ver `cabeceras`): una v1 recibe las de
 * siempre (X-Webhook-Event, X-Webhook-Id, X-Webhook-Timestamp y la firma de "timestamp.cuerpo");
 * una v2, `application/cloudevents+json` y la firma del contrato v2 (firma-cloudevents.ts). Las dos
 * llevan X-Correlation-Id y NINGUNA lleva traceparent ni tracestate: a un tercero no se le revela
 * la traza interna. Un 2xx cierra la entrega; cualquier otra cosa la reintenta con espera creciente
 * (v1: 1, 5, 30 y 120 min, 5 intentos; v2: 1, 5, 30, 120 y 360 min, 6 intentos) y, agotados, la
 * deja FALLIDO. Si las últimas 10 entregas resueltas de una suscripción son FALLIDO, se da de baja.
 *
 * Cada intento es un span CLIENT hijo de la traza que trajo el evento (la del relevo del core), y
 * sus líneas de log llevan el correlationId del evento. Registra cada intento sin URL, secreto,
 * firma ni cuerpo, y cuenta notifier_deliveries_total{result, format}.
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
    private readonly observabilidad: Observabilidad,
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
        const salidas = await Promise.allSettled(
          lote.map((e) => conCorrelacion(e.correlationId, () => this.entregar(e))),
        );
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
    const { resultado: envio, span } = await this.enviar(e);
    const ahora = this.reloj.ahora();
    const exito = envio.codigoHttp !== null && envio.codigoHttp >= 200 && envio.codigoHttp < 300;
    // Una suscripción dada de baja ya no recibe nada: no hay reintento
    const proximo =
      exito || !e.suscripcionActiva ? null : proximoIntentoTras(e.intentos, ahora, e.formato);
    const estado = await this.entregas.registrarResultado(e.id, e.intentos, ahora, envio, proximo);
    if (estado !== null) this.observabilidad.notifier.entrega(RESULTADO_METRICA[estado], e.formato);
    // La línea del intento lleva el traceId y el spanId de su span CLIENT (si hubo envío)
    const registrar = () =>
      this.logger.log(
        `Entrega ${e.id} (${e.tipo} ${e.formato}) intento ${e.intentos}/` +
          `${reintentosDe(e.formato).maximoIntentos}: ${estado ?? 'NO_APLICADA'} ` +
          `${envio.codigoHttp ?? envio.error}`,
      );
    if (span) this.observabilidad.trazas.conSpan(span, registrar);
    else registrar();
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

  /**
   * El POST firmado, dentro de un span CLIENT hijo de la traza del evento; nunca lanza: un error es
   * un resultado con su código. El span no lleva la URL ni nada del tercero: solo el método, el
   * status y, si falló, un `error.type` de la lista cerrada.
   */
  private async enviar(e: EntregaReclamada): Promise<{ resultado: ResultadoWebhook; span?: Span }> {
    if (!e.suscripcionActiva) {
      return { resultado: { codigoHttp: null, error: 'SUBSCRIPTION_INACTIVE' } };
    }
    let secreto: string;
    try {
      secreto = this.cifrado.descifrar(e.secretoCifrado);
    } catch {
      return { resultado: { codigoHttp: null, error: 'SECRET_UNREADABLE' } };
    }
    const cuerpo = JSON.stringify(e.cuerpo);
    const { trazas } = this.observabilidad;
    const span = trazas.iniciar(
      'POST webhook',
      SpanKind.CLIENT,
      { 'http.request.method': 'POST' },
      contextoDeTraceparent(e.traceparent),
    );
    const inicio = process.hrtime.bigint();
    let resultado: ResultadoWebhook;
    try {
      resultado = await trazas.conSpan(span, () =>
        this.cliente.enviar({ url: e.url, cuerpo, cabeceras: this.cabeceras(e, secreto, cuerpo) }),
      );
    } catch {
      resultado = { codigoHttp: null, error: 'NETWORK_ERROR' };
    }
    const { codigoHttp } = resultado;
    if (codigoHttp !== null) span.setAttribute('http.response.status_code', codigoHttp);
    if (codigoHttp === null) {
      marcarError(span, resultado.error === 'TIMEOUT' ? 'timeout' : 'unavailable');
    } else if (codigoHttp >= 500) {
      marcarError(span, String(Math.min(codigoHttp, 504)));
    }
    span.end();
    this.observabilidad.notifier.duracionEntrega.observe(
      { format: e.formato },
      Number(process.hrtime.bigint() - inicio) / 1e9,
    );
    return { resultado, span };
  }

  /**
   * Las cabeceras de la entrega según el formato de la suscripción. Nunca `traceparent` ni
   * `tracestate` (el estándar de observabilidad: la entrega a un tercero no revela la traza).
   */
  private cabeceras(e: EntregaReclamada, secreto: string, cuerpo: string): Record<string, string> {
    if (e.formato === 'v2') {
      return {
        'Content-Type': CONTENT_TYPE_CLOUDEVENTS,
        ...cabecerasDeFirmaV2(secreto, cuerpo),
        [CABECERA_CORRELACION]: e.correlationId,
      };
    }
    const timestamp = Math.floor(this.reloj.ahora().getTime() / 1000);
    return {
      'Content-Type': 'application/json',
      'X-Webhook-Event': e.tipo,
      'X-Webhook-Id': e.eventId,
      'X-Webhook-Timestamp': String(timestamp),
      'X-Webhook-Signature': firmar(secreto, timestamp, cuerpo),
      [CABECERA_CORRELACION]: e.correlationId,
    };
  }
}
