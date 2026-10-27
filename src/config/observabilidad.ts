import { ConfigService } from '@nestjs/config';

/** Identidad del notifier en las trazas y las métricas (docs/OBSERVABILIDAD.md del gateway, sección 1). */
export const SERVICIO_POR_DEFECTO = 'quinde-notifier';

/** Puerto de /metrics si METRICS_PORT no dice otro: el de un contenedor; en local, 9468. */
export const PUERTO_METRICAS_POR_DEFECTO = 9464;

/** Fracción de trazas raíz que se registran si OTEL_TRACES_SAMPLER_ARG no dice otra. */
export const MUESTREO_POR_DEFECTO = { desarrollo: 1.0, produccion: 0.1 } as const;

/** Lo que fija el entorno de la observabilidad, ya validado por entorno.ts. */
export interface ConfiguracionObservabilidad {
  servicio: string;
  version: string;
  entorno: string;
  endpointOtlp: string | undefined;
  muestreo: number;
  confiarEntrante: boolean;
  /** 0 apaga el servidor de métricas. */
  puertoMetricas: number;
}

export function esUrlOtlp(valor: unknown): boolean {
  if (typeof valor !== 'string') return false;
  try {
    const url = new URL(valor);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

/**
 * OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_TRACES_SAMPLER_ARG, TRACE_TRUST_INCOMING y
 * METRICS_PORT, con sus valores por defecto. El notifier es un servicio interno: continúa el
 * `traceparent` que recibe (TRACE_TRUST_INCOMING=true) porque solo lo alcanzan el gateway y el relevo del core.
 */
export function configuracionObservabilidad(
  config: ConfigService,
  version: string,
): ConfiguracionObservabilidad {
  const entorno = config.get<string>('NODE_ENV') ?? 'development';
  const fraccion = config.get<string>('OTEL_TRACES_SAMPLER_ARG');
  return {
    servicio: config.get<string>('OTEL_SERVICE_NAME') || SERVICIO_POR_DEFECTO,
    version,
    entorno,
    endpointOtlp: config.get<string>('OTEL_EXPORTER_OTLP_ENDPOINT') || undefined,
    muestreo:
      fraccion !== undefined && fraccion !== ''
        ? Number(fraccion)
        : entorno === 'production'
          ? MUESTREO_POR_DEFECTO.produccion
          : MUESTREO_POR_DEFECTO.desarrollo,
    confiarEntrante: config.get<string>('TRACE_TRUST_INCOMING') !== 'false',
    puertoMetricas: config.get<number>('METRICS_PORT') ?? PUERTO_METRICAS_POR_DEFECTO,
  };
}
