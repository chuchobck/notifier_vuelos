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
