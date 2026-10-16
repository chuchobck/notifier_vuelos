/**
 * Escribe el OpenAPI del servicio en contracts/notifier-openapi.json:
 *
 *   npm run openapi:export
 *
 * El documento sale de los mismos decoradores que sirven /api/docs, sin base de datos: la app se
 * arma (no se inicia) con un entorno de relleno. Una prueba (test/openapi.e2e-spec.ts) falla si
 * el archivo versionado quedó desactualizado.
 */
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppModule } from '../app.module';
import { configurarApp } from '../configurar-app';
import { crearDocumentoOpenApi } from '../config/swagger';

export const ARCHIVO_OPENAPI = join(process.cwd(), 'contracts', 'notifier-openapi.json');

/** El documento como texto estable: dos espacios y salto de línea final. */
export function serializarOpenApi(documento: object): string {
  return `${JSON.stringify(documento, null, 2)}\n`;
}

/** Un entorno de relleno: el documento no depende de ninguna variable, pero la app no se arma sin uno válido. */
function entornoDeRelleno(): void {
  Object.assign(process.env, {
    NODE_ENV: 'development',
    PORT: '3002',
    DATABASE_URL: 'postgresql://openapi:openapi@127.0.0.1:1/openapi?schema=notificaciones',
    JWT_ISSUER: 'http://localhost:3001',
    JWT_AUDIENCE: 'quinde-vuelos-api',
    JWKS_URL: '',
    WEBHOOK_SECRET_KEY: 'relleno-solo-para-exportar-el-openapi-0000',
    NOTIFIER_DELIVERY_JOB_ENABLED: 'false',
  });
}

async function principal(): Promise<void> {
  entornoDeRelleno();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  configurarApp(app, { logger: false });
  const documento = crearDocumentoOpenApi(app);
  mkdirSync(dirname(ARCHIVO_OPENAPI), { recursive: true });
  writeFileSync(ARCHIVO_OPENAPI, serializarOpenApi(documento));
  await app.close();
  console.log(`OpenAPI escrito en ${ARCHIVO_OPENAPI}`);
}

if (require.main === module) {
  principal().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
