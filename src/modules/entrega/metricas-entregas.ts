import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Gauge } from 'prom-client';
import { Reloj } from '../../common/reloj';
import { Observabilidad } from '../../observabilidad/observabilidad';
import { EntregaRepository } from './entrega.repository';

/** Cuánto, como mucho, puede tardar la consulta de las entregas al raspar /metrics. */
export const PLAZO_CONSULTA_MS = 2_000;

/** Una lectura vale esto: los dos gauges de un mismo raspado comparten una sola consulta. */
const VIGENCIA_LECTURA_MS = 1_000;

/**
 * Los gauges de la bandeja de salida (entrega), como los de la bandeja del core:
 *
 * - `notifier_deliveries_pending`: entregas PENDIENTE (por enviar o por reintentar).
 * - `notifier_deliveries_oldest_pending_seconds`: la edad de la PENDIENTE más vieja (0 si no hay).
 *
 * Se calculan al raspar, con una consulta barata (el índice parcial de PENDIENTE) y con plazo:
 * 2 s en la base y 2,5 s en total. Si la base no contesta a tiempo, el gauge no se publica en ese
 * raspado (una serie ausente, no un 0 engañoso ni un raspado colgado). Sin etiquetas: ningún id,
 * dueño, URL ni tipo de evento.
 */
@Injectable()
export class MetricasEntregas implements OnModuleInit {
  private readonly logger = new Logger(MetricasEntregas.name);
  private lectura?: { cuando: number; datos: Promise<{ pendientes: number; desde: Date | null }> };

  constructor(
    private readonly observabilidad: Observabilidad,
    private readonly entregas: EntregaRepository,
    private readonly reloj: Reloj,
  ) {}

  onModuleInit(): void {
    const registers = [this.observabilidad.metricas.registro];
    const pendientes = new Gauge({
      name: 'notifier_deliveries_pending',
      help: 'Entregas PENDIENTE (por enviar o por reintentar)',
      registers,
      collect: async () => {
        const lectura = await this.leer();
        if (lectura) pendientes.set(lectura.pendientes);
        else pendientes.remove();
      },
    });
    const masViejo = new Gauge({
      name: 'notifier_deliveries_oldest_pending_seconds',
      help: 'Edad en segundos de la entrega PENDIENTE más vieja (0 si no hay ninguna)',
      registers,
      collect: async () => {
        const lectura = await this.leer();
        if (lectura) {
          masViejo.set(
            lectura.desde === null
              ? 0
              : Math.max(0, (this.reloj.ahora().getTime() - lectura.desde.getTime()) / 1000),
          );
        } else {
          masViejo.remove();
        }
      },
    });
  }

  /** La lectura de las entregas, o null si no llegó a tiempo (o falló). Nunca lanza. */
  private async leer(): Promise<{ pendientes: number; desde: Date | null } | null> {
    const ahora = Date.now();
    if (!this.lectura || ahora - this.lectura.cuando > VIGENCIA_LECTURA_MS) {
      this.lectura = {
        cuando: ahora,
        datos: this.entregas.resumenPendientes(PLAZO_CONSULTA_MS),
      };
    }
    let temporizador: NodeJS.Timeout | undefined;
    const tope = new Promise<null>((listo) => {
      temporizador = setTimeout(() => listo(null), PLAZO_CONSULTA_MS + 500);
    });
    try {
      return await Promise.race([this.lectura.datos, tope]);
    } catch (error) {
      this.logger.warn(`No se pudo leer las entregas para las métricas: ${(error as Error).name}`);
      return null;
    } finally {
      clearTimeout(temporizador);
    }
  }
}
