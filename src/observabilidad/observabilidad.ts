import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { Server } from 'node:http';
import { join } from 'node:path';
import { configuracionObservabilidad } from '../config/observabilidad';
import { Metricas, servidorMetricas } from './metricas';
import { MetricasNotifier } from './metricas-notifier';
import { Trazas } from './trazas';

/** La versión de package.json: dist/observabilidad y src/observabilidad quedan a la misma altura. */
function versionDelPaquete(): string {
  try {
    const paquete = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    return typeof paquete.version === 'string' ? paquete.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * La observabilidad del notifier (fase 7e): trazas (OpenTelemetry, W3C Trace Context), métricas
 * (prom-client) y el servidor de /metrics en su propio puerto, con el estándar del gateway
 * (docs/OBSERVABILIDAD.md de gateway_vuelos). El SDK de trazas siempre arranca, aunque no se
 * exporte nada, y los spans son manuales. Es la misma clase del core, sin lo que el notifier no usa.
 */
@Injectable()
export class Observabilidad implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Observabilidad');
  readonly trazas: Trazas;
  readonly metricas: Metricas;
  readonly notifier: MetricasNotifier;
  private readonly puertoMetricas: number;
  private servidor: Server | undefined;

  constructor(config: ConfigService) {
    const c = configuracionObservabilidad(config, versionDelPaquete());
    this.puertoMetricas = c.puertoMetricas;
    this.trazas = new Trazas({
      servicio: c.servicio,
      version: c.version,
      entorno: c.entorno,
      endpointOtlp: c.endpointOtlp,
      muestreo: c.muestreo,
      confiarEntrante: c.confiarEntrante,
    });
    this.metricas = new Metricas({ servicio: c.servicio, version: c.version, entorno: c.entorno });
    this.notifier = new MetricasNotifier(this.metricas.registro);
  }

  onApplicationBootstrap(): void {
    if (this.puertoMetricas === 0) {
      this.logger.log('Métricas apagadas (METRICS_PORT=0)');
      return;
    }
    const servidor = servidorMetricas(this.metricas);
    // Un puerto ocupado no tumba la API: sin métricas, pero sirviendo
    servidor.on('error', (error: NodeJS.ErrnoException) =>
      this.logger.warn(`No se pudo abrir /metrics en :${this.puertoMetricas} (${error.code})`),
    );
    servidor.listen(this.puertoMetricas, () =>
      this.logger.log(`Métricas en :${this.puertoMetricas}/metrics (puerto aparte, no público)`),
    );
    this.servidor = servidor;
  }

  /** Cierra /metrics y envía lo que quede en la cola de trazas (con tope de tiempo). */
  async onModuleDestroy(): Promise<void> {
    const servidor = this.servidor;
    if (servidor?.listening) {
      await new Promise<void>((listo) => {
        servidor.close(() => listo());
        servidor.closeAllConnections();
      });
    }
    await this.trazas.cerrar();
  }
}
