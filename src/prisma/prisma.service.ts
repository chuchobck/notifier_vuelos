import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ITXClientDenyList } from '@prisma/client/runtime/client';
import { PrismaClient } from '../generated/prisma/client';
import { bloqueoBorradoFisico } from './extensiones/bloqueo-borrado-fisico';

/** Esquema por defecto si la URL no trae `?schema=`. */
export const ESQUEMA_POR_DEFECTO = 'notificaciones';

/**
 * Cliente de Prisma con las extensiones del proyecto. Lo usa PrismaService y también las
 * herramientas de línea de comandos (src/cli/), que no levantan la app de Nest.
 */
export function crearClientePrisma(url: string) {
  // Sin tope, pg espera para siempre una base caída y /health/ready nunca responde.
  const adaptador = new PrismaPg(
    { connectionString: url, connectionTimeoutMillis: 5_000 },
    { schema: esquemaDeUrl(url) },
  );
  return new PrismaClient({ adapter: adaptador }).$extends(bloqueoBorradoFisico);
}

export type ClienteNotificaciones = ReturnType<typeof crearClientePrisma>;

/** Cliente que recibe el callback de una transacción interactiva (sin $connect, $on ni $extends). */
export type TransaccionNotificaciones = Omit<ClienteNotificaciones, ITXClientDenyList>;

/**
 * Dueño de la conexión a PostgreSQL. Solo los repositories lo inyectan.
 *
 * Prisma 7 se conecta con el adaptador de `pg`, que no lee el `?schema=` de la URL: el esquema
 * se toma de la URL y se pasa aparte (por defecto, `notificaciones`).
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  readonly db: ClienteNotificaciones;

  constructor(config: ConfigService) {
    this.db = crearClientePrisma(config.getOrThrow<string>('DATABASE_URL'));
  }

  /**
   * Con el adaptador de pg la conexión es perezosa: se prueba con una consulta real. Si la base
   * no responde, el servicio arranca igual y /health/ready responde 503 hasta que vuelva.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.db.$queryRaw`SELECT 1`;
      this.logger.log('Conectado a PostgreSQL');
    } catch (error) {
      this.logger.warn(`PostgreSQL no responde al arrancar: ${resumirError(error)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
  }

  /** Corre `trabajo` en una transacción interactiva. */
  transaccion<T>(trabajo: (tx: TransaccionNotificaciones) => Promise<T>): Promise<T> {
    return this.db.$transaction((tx) => trabajo(tx));
  }
}

/**
 * Una línea para el log sin datos de la consulta: el nombre del error y su código. El mensaje
 * de un error de Prisma puede copiar los valores de la invocación (un hash, un token).
 */
export function resumirError(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const codigo = (error as { code?: unknown }).code;
  return [error.name, typeof codigo === 'string' ? codigo : undefined].filter(Boolean).join(' ');
}

export function esquemaDeUrl(url: string): string {
  return new URL(url).searchParams.get('schema') ?? ESQUEMA_POR_DEFECTO;
}
