import { Type } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getStorageToken } from '@nestjs/throttler';
import { AppModule } from '../../src/app.module';
import { LoggerJson } from '../../src/common/logger/logger-json';
import { Reloj } from '../../src/common/reloj';
import { configurarApp } from '../../src/configurar-app';
import { ClavesJwks } from '../../src/modules/auth/seguridad/claves-jwks';
import { VerificadorJwks } from '../../src/modules/auth/seguridad/verificador-jwks';
import { VerificadorToken } from '../../src/modules/auth/seguridad/verificador-token';
import { ClienteWebhook } from '../../src/modules/entrega/cliente-webhook';
import { AUDIENCIA_PRUEBAS, EMISOR_PRUEBAS } from './entorno-pruebas';
import { IdentidadFalsa } from './identidad-falsa';
import { LimitesReiniciables } from './limites';
import { RelojDePrueba } from './reloj';

export interface OpcionesCrearApp {
  /**
   * El servicio de identidad cuyo JWKS se usa para verificar los tokens. Sin esto, el JWKS es
   * el de JWKS_URL (un puerto cerrado): toda ruta con token responde 503.
   */
  identidad?: IdentidadFalsa;
  /** Reemplaza el Reloj de la aplicación (por ejemplo, un RelojDePrueba que se adelanta). */
  reloj?: Reloj;
  /**
   * Contadores del límite de peticiones que la prueba puede reiniciar. Sin esto, el límite usa
   * el Reloj de la app (el de `reloj` si se pasa): una prueba de límites pasa un RelojDePrueba.
   */
  limites?: LimitesReiniciables;
  /** Reemplaza el HTTP de las entregas (un doble que simula un receptor caído, lento...). */
  clienteWebhook?: ClienteWebhook;
  /**
   * Junta cada línea de log (JSON) en este arreglo, con debug encendido. Sin esto, los logs se
   * apagan para no llenar la salida de Jest. El Logger de Nest es global en el proceso: la última
   * app creada decide adónde van.
   */
  logs?: string[];
  /** Controllers que solo existen en la prueba. */
  controllers?: Type[];
  /** Otros providers reemplazados. */
  reemplazos?: Array<{ proveedor: unknown; valor: unknown }>;
}

/**
 * Levanta el servicio completo, con la misma configuración que `main.ts` y la base del `.env`
 * (o DATABASE_URL). Las pruebas e2e necesitan PostgreSQL arriba.
 */
export async function crearApp(opciones: OpcionesCrearApp = {}): Promise<NestExpressApplication> {
  let constructor = Test.createTestingModule({
    imports: [AppModule],
    controllers: opciones.controllers ?? [],
  });
  if (opciones.reloj) constructor = constructor.overrideProvider(Reloj).useValue(opciones.reloj);
  if (opciones.identidad) {
    // El mismo verificador que arma AutenticacionModule, con el JWKS de la identidad falsa
    const reloj = opciones.reloj ?? new Reloj();
    const urlJwks = opciones.identidad.urlJwks;
    constructor = constructor
      .overrideProvider(VerificadorToken)
      .useValue(
        new VerificadorJwks(
          new ClavesJwks(urlJwks, reloj),
          { emisor: EMISOR_PRUEBAS, audiencia: AUDIENCIA_PRUEBAS, urlJwks },
          reloj,
        ),
      );
  }
  if (opciones.limites) {
    // Con el reloj de la prueba, o con uno quieto: el límite nunca depende del reloj de la máquina
    opciones.limites.usarReloj(opciones.reloj ?? new RelojDePrueba());
    constructor = constructor.overrideProvider(getStorageToken()).useValue(opciones.limites);
  }
  if (opciones.clienteWebhook) {
    constructor = constructor.overrideProvider(ClienteWebhook).useValue(opciones.clienteWebhook);
  }
  for (const { proveedor, valor } of opciones.reemplazos ?? []) {
    constructor = constructor.overrideProvider(proveedor).useValue(valor);
  }
  const modulo = await constructor.compile();
  const app = modulo.createNestApplication<NestExpressApplication>({ bufferLogs: false });

  const logger = opciones.logs
    ? new LoggerJson((linea) => opciones.logs?.push(linea), ['debug', 'log', 'warn', 'error'])
    : false;
  configurarApp(app, { logger });
  await app.init();
  return app;
}
