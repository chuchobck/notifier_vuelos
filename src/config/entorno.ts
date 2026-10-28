import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  validateSync,
} from 'class-validator';
import { esOrigenEmisor, esUrlJwks } from './autenticacion';
import { FORMATO_CODIGO_AEROLINEA } from './eventos';
import { esUrlOtlp } from './observabilidad';
import { esOrigenValido, listarOrigenes } from './origenes-cors';
import { parsearTrustProxy } from './proxy';

export const ENTORNOS = ['development', 'production', 'test'] as const;
export const LARGO_MINIMO_WEBHOOK_KEY = 32;
export type Entorno = (typeof ENTORNOS)[number];

@ValidatorConstraint({ name: 'listaDeOrigenes' })
class ListaDeOrigenes implements ValidatorConstraintInterface {
  validate(valor: unknown): boolean {
    return typeof valor === 'string' && listarOrigenes(valor).every(esOrigenValido);
  }

  // No repite los valores: el mensaje nombra la variable, nunca su contenido.
  defaultMessage(): string {
    return (
      'CORS_ORIGINS debe ser una lista de orígenes separados por coma, como ' +
      'https://app.example.com (sin ruta, sin barra final y sin "*")'
    );
  }
}

@ValidatorConstraint({ name: 'trustProxyValido' })
class TrustProxyValido implements ValidatorConstraintInterface {
  validate(valor: unknown): boolean {
    return typeof valor === 'string' && parsearTrustProxy(valor) !== undefined;
  }

  defaultMessage(): string {
    return (
      'TRUST_PROXY debe ser false, un número de proxies (1, 2...) o una lista separada por coma ' +
      'de IP, CIDR, loopback, linklocal o uniquelocal; "true" no se acepta porque deja falsear la IP'
    );
  }
}

/** JWT_ISSUER es el origen del servicio de identidad, sin ruta (https en producción). */
@ValidatorConstraint({ name: 'emisorValido' })
class EmisorValido implements ValidatorConstraintInterface {
  validate(valor: unknown, { object }: ValidationArguments): boolean {
    return esOrigenEmisor(valor, (object as VariablesEntorno).NODE_ENV === 'production');
  }

  defaultMessage(): string {
    return (
      'JWT_ISSUER debe ser el origen del servicio de identidad sin ruta ni barra final, como ' +
      'https://identity.quinde.example (https con NODE_ENV=production)'
    );
  }
}

@ValidatorConstraint({ name: 'urlJwks' })
class UrlJwks implements ValidatorConstraintInterface {
  validate(valor: unknown, { object }: ValidationArguments): boolean {
    return esUrlJwks(valor, (object as VariablesEntorno).NODE_ENV === 'production');
  }

  defaultMessage(): string {
    return 'JWKS_URL debe ser una URL https (http solo fuera de producción) sin usuario, clave ni fragmento';
  }
}

/** OTEL_EXPORTER_OTLP_ENDPOINT: URL http(s) sin usuario, clave, query ni fragmento. */
@ValidatorConstraint({ name: 'urlOtlp' })
class UrlOtlp implements ValidatorConstraintInterface {
  validate(valor: unknown): boolean {
    return esUrlOtlp(valor);
  }

  defaultMessage(): string {
    return 'OTEL_EXPORTER_OTLP_ENDPOINT debe ser una URL http(s) sin usuario, clave, query ni fragmento';
  }
}

/** METRICS_PORT: distinto de PORT (el ingress solo expone PORT); 0 lo apaga. */
@ValidatorConstraint({ name: 'puertoMetricas' })
class PuertoMetricas implements ValidatorConstraintInterface {
  validate(valor: unknown, { object }: ValidationArguments): boolean {
    return valor === 0 || valor !== (object as VariablesEntorno).PORT;
  }

  defaultMessage(): string {
    return 'METRICS_PORT debe ser distinto de PORT (el ingress solo expone PORT)';
  }
}

/**
 * Variables de entorno que el servicio necesita para arrancar. Las obligatorias no tienen
 * valor por defecto: si falta una o tiene un formato inválido, el servicio no levanta. Las
 * opcionales (`@IsOptional`) llevan su valor por defecto documentado en `.env.example` y en
 * docs/DEPLOY.md. Un mensaje de error nombra la variable, nunca su valor.
 */
export class VariablesEntorno {
  // class-validator evalúa de abajo hacia arriba: lo obligatorio va pegado a la propiedad.
  @Matches(/^postgres(ql)?:\/\/\S+$/, {
    message: 'DATABASE_URL debe ser una URL de PostgreSQL (postgresql://...)',
  })
  @IsString({ message: 'DATABASE_URL es obligatoria' })
  DATABASE_URL!: string;

  @Min(1, { message: 'PORT debe estar entre 1 y 65535' })
  @Max(65535, { message: 'PORT debe estar entre 1 y 65535' })
  @IsInt({ message: 'PORT es obligatorio y debe ser un número entero' })
  PORT!: number;

  @IsIn(ENTORNOS, { message: `NODE_ENV es obligatorio y debe ser uno de: ${ENTORNOS.join(', ')}` })
  NODE_ENV!: Entorno;

  /**
   * Clave con la que se cifra el secreto de cada suscripción (AES-256-GCM, derivada con HKDF).
   * Hace falta porque el secreto se necesita en claro para firmar las entregas. Obligatoria, de al
   * menos 32 caracteres. Para migrar las suscripciones del core sin que los terceros cambien su
   * secreto, tiene que ser la MISMA WEBHOOK_SECRET_KEY del core (docs/MIGRACION.md). Cambiarla
   * deja ilegibles los secretos ya guardados. Generar con:
   *   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   */
  @MinLength(LARGO_MINIMO_WEBHOOK_KEY, {
    message: `WEBHOOK_SECRET_KEY debe tener al menos ${LARGO_MINIMO_WEBHOOK_KEY} caracteres`,
  })
  @IsString({ message: 'WEBHOOK_SECRET_KEY es obligatoria' })
  WEBHOOK_SECRET_KEY!: string;

  /**
   * `iss` de los tokens que se aceptan: el JWT_ISSUER del servicio de identidad, un origen sin
   * ruta (https en producción), que se compara texto a texto.
   */
  @Validate(EmisorValido)
  @Matches(/^\S+$/, { message: 'JWT_ISSUER no puede tener espacios' })
  @MaxLength(200, { message: 'JWT_ISSUER admite hasta 200 caracteres' })
  @IsString({ message: 'JWT_ISSUER es obligatoria' })
  JWT_ISSUER!: string;

  /**
   * `aud` que deben traer los tokens. identity_vuelos emite uno solo para todo el sistema
   * (quinde-vuelos-api): el token de una persona sirve igual en el core y aquí.
   */
  @Matches(/^\S+$/, { message: 'JWT_AUDIENCE no puede tener espacios' })
  @MaxLength(200, { message: 'JWT_AUDIENCE admite hasta 200 caracteres' })
  @IsString({ message: 'JWT_AUDIENCE es obligatoria' })
  JWT_AUDIENCE!: string;

  /**
   * De dónde se bajan las claves públicas. Sin valor: {JWT_ISSUER}/.well-known/jwks.json. Sirve
   * si el JWKS se lee por otra ruta (una red interna).
   */
  @Validate(UrlJwks)
  @IsOptional()
  JWKS_URL?: string;

  /** Orígenes que pueden llamar desde un navegador. Sin valor: ninguno. */
  @Validate(ListaDeOrigenes)
  @IsOptional()
  CORS_ORIGINS?: string;

  /** Proxies delante del servicio. Sin valor: ninguno. Ver src/config/proxy.ts. */
  @Validate(TrustProxyValido)
  @IsOptional()
  TRUST_PROXY?: string;

  /** Peticiones por IP y por ventana en todo el servicio. Sin valor: 100. */
  @Max(100_000, { message: 'RATE_LIMIT_MAX debe estar entre 1 y 100000' })
  @Min(1, { message: 'RATE_LIMIT_MAX debe estar entre 1 y 100000' })
  @IsInt({ message: 'RATE_LIMIT_MAX debe ser un número entero' })
  @IsOptional()
  RATE_LIMIT_MAX?: number;

  /**
   * Publicaciones por minuto e IP en POST /internal/v1/events, que no cuenta en el límite global
   * (el core publica en ráfagas). Sin valor: 1200.
   */
  @Max(100_000, { message: 'EVENTS_RATE_LIMIT_MAX debe estar entre 1 y 100000' })
  @Min(1, { message: 'EVENTS_RATE_LIMIT_MAX debe estar entre 1 y 100000' })
  @IsInt({ message: 'EVENTS_RATE_LIMIT_MAX debe ser un número entero' })
  @IsOptional()
  EVENTS_RATE_LIMIT_MAX?: number;

  /**
   * Proceso periódico que envía las entregas pendientes (POST firmado a la URL de cada
   * suscripción) y reintenta las fallidas. Sin valor: true. Con false, los eventos se acumulan en
   * la bandeja sin enviarse (las pruebas lo apagan).
   */
  @IsIn(['true', 'false'], { message: 'NOTIFIER_DELIVERY_JOB_ENABLED debe ser true o false' })
  @IsOptional()
  NOTIFIER_DELIVERY_JOB_ENABLED?: string;

  /** Cada cuántos segundos corre ese proceso. Sin valor: 10. */
  @Max(3600, { message: 'NOTIFIER_DELIVERY_JOB_INTERVAL_SECONDS debe estar entre 5 y 3600' })
  @Min(5, { message: 'NOTIFIER_DELIVERY_JOB_INTERVAL_SECONDS debe estar entre 5 y 3600' })
  @IsInt({ message: 'NOTIFIER_DELIVERY_JOB_INTERVAL_SECONDS debe ser un número entero' })
  @IsOptional()
  NOTIFIER_DELIVERY_JOB_INTERVAL_SECONDS?: number;

  /**
   * El código de la aerolínea en el `source` de cada CloudEvent (`/aerolineas/<código>/vuelos`,
   * contrato v2 §8): un segmento en minúsculas, como `ecoairlines`. Sin valor: quinde.
   */
  @Matches(FORMATO_CODIGO_AEROLINEA, {
    message:
      'AIRLINE_CODE debe ser un código en minúsculas, dígitos y guiones (2 a 40), como ecoairlines',
  })
  @IsOptional()
  AIRLINE_CODE?: string;

  /** `service.name` de las trazas y las métricas. Sin valor: quinde-notifier. */
  @Matches(/^[a-z][a-z0-9-]{0,62}$/, {
    message: 'OTEL_SERVICE_NAME debe ser un nombre en minúsculas, dígitos y guiones',
  })
  @IsOptional()
  OTEL_SERVICE_NAME?: string;

  /** Base OTLP/HTTP del recolector (http://jaeger:4318). Sin valor: las trazas no se exportan. */
  @Validate(UrlOtlp)
  @IsOptional()
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;

  /** Fracción de trazas raíz que se registran (0 a 1). Sin valor: 1.0 en desarrollo y 0.1 en producción. */
  @Matches(/^(0(\.\d+)?|1(\.0+)?)$/, {
    message: 'OTEL_TRACES_SAMPLER_ARG debe ser una fracción entre 0 y 1',
  })
  @IsOptional()
  OTEL_TRACES_SAMPLER_ARG?: string;

  /**
   * Continuar el traceparent entrante. Sin valor: true (el notifier es interno: lo alcanzan el
   * gateway y el relevo del core).
   */
  @IsIn(['true', 'false'], { message: 'TRACE_TRUST_INCOMING debe ser true o false' })
  @IsOptional()
  TRACE_TRUST_INCOMING?: string;

  /** Puerto aparte de /metrics; 0 lo apaga. Sin valor: 9464 (en local, 9468). */
  @Validate(PuertoMetricas)
  @Max(65535, { message: 'METRICS_PORT debe estar entre 0 y 65535' })
  @Min(0, { message: 'METRICS_PORT debe estar entre 0 y 65535' })
  @IsInt({ message: 'METRICS_PORT debe ser un número entero' })
  @IsOptional()
  METRICS_PORT?: number;

  /** Duración de la ventana del límite, en segundos. Sin valor: 60. */
  @Max(86_400, { message: 'RATE_LIMIT_WINDOW_SECONDS debe estar entre 1 y 86400' })
  @Min(1, { message: 'RATE_LIMIT_WINDOW_SECONDS debe estar entre 1 y 86400' })
  @IsInt({ message: 'RATE_LIMIT_WINDOW_SECONDS debe ser un número entero' })
  @IsOptional()
  RATE_LIMIT_WINDOW_SECONDS?: number;
}

/** Se pasa a ConfigModule.forRoot({ validate }); corre una sola vez, al arrancar. */
export function validarEntorno(config: Record<string, unknown>): VariablesEntorno {
  // Una variable vacía (`JWKS_URL=` en el .env) cuenta como no definida
  const definidas = Object.fromEntries(Object.entries(config).filter(([, valor]) => valor !== ''));
  const variables = plainToInstance(VariablesEntorno, definidas, {
    enableImplicitConversion: true,
  });
  const errores = validateSync(variables, { stopAtFirstError: true });

  if (errores.length > 0) {
    const problemas = errores.map(
      (e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`,
    );
    throw new Error(`Variables de entorno inválidas o faltantes:\n${problemas.join('\n')}`);
  }
  return variables;
}
