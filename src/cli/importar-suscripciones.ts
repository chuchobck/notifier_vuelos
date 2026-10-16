/**
 * Importa las suscripciones exportadas por el core (una línea JSON por suscripción; formato en
 * docs/MIGRACION.md):
 *
 *   npm run suscripciones:importar -- suscripciones.jsonl
 *
 *   # dentro de la imagen desplegada
 *   node dist/cli/importar-suscripciones.js /ruta/suscripciones.jsonl
 *
 * Necesita DATABASE_URL y WEBHOOK_SECRET_KEY (del entorno o del .env): la MISMA clave del core,
 * o ningún secreto se podrá descifrar. Es idempotente: correrlo otra vez con el mismo archivo
 * solo cuenta las que ya existían.
 *
 * No imprime secretos ni URL: de cada línea rechazada dice el número y el campo que falló.
 * Sale con 0 si no rechazó ninguna, 1 si rechazó alguna y 2 si no pudo empezar.
 */
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { LARGO_MINIMO_WEBHOOK_KEY } from '../config/entorno';
import { AuditoriaRepository } from '../modules/auditoria/auditoria.repository';
import { AuditoriaSuscripciones } from '../modules/auditoria/auditoria.service';
import { CifradoSecreto } from '../modules/compartido/cifrado-secreto';
import { ImportadorSuscripciones } from '../modules/suscripcion/importacion/importador';
import { SuscripcionRepository } from '../modules/suscripcion/suscripcion.repository';
import { PrismaService, resumirError } from '../prisma/prisma.service';

/** Adónde va cada línea de la salida (la consola; las pruebas pasan un arreglo). */
export type Salida = (linea: string) => void;

/**
 * Importa el archivo y devuelve el código de salida. Lee DATABASE_URL y WEBHOOK_SECRET_KEY del
 * entorno (o del .env si DATABASE_URL no está).
 */
export async function importarArchivo(
  archivo: string | undefined,
  escribir: Salida,
  errores: Salida = escribir,
): Promise<number> {
  if (!archivo) {
    errores('Uso: npm run suscripciones:importar -- <archivo.jsonl>');
    return 2;
  }
  if (!existsSync(archivo)) {
    errores(`No existe el archivo ${basename(archivo)}`);
    return 2;
  }
  if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
  if (!process.env.DATABASE_URL) {
    errores('Falta DATABASE_URL (en el entorno o en .env)');
    return 2;
  }
  if ((process.env.WEBHOOK_SECRET_KEY ?? '').length < LARGO_MINIMO_WEBHOOK_KEY) {
    errores(
      `Falta WEBHOOK_SECRET_KEY o tiene menos de ${LARGO_MINIMO_WEBHOOK_KEY} caracteres ` +
        '(tiene que ser la misma del core)',
    );
    return 2;
  }

  const config = new ConfigService();
  const prisma = new PrismaService(config);
  try {
    const importador = new ImportadorSuscripciones(
      prisma,
      new SuscripcionRepository(prisma),
      new CifradoSecreto(config),
      new AuditoriaSuscripciones(new AuditoriaRepository()),
    );
    const resumen = await importador.importar(readFileSync(archivo, 'utf8').split(/\r?\n/));

    escribir(`Importación de suscripciones desde ${basename(archivo)}`);
    for (const r of resumen.lineas.filter((l) => l.desenlace === 'rechazada')) {
      escribir(`  línea ${r.linea}: rechazada (${r.motivo})`);
    }
    escribir(
      `Importadas: ${resumen.importadas} · ya existían: ${resumen.existentes} · ` +
        `rechazadas: ${resumen.rechazadas}`,
    );
    return resumen.rechazadas > 0 ? 1 : 0;
  } catch (error) {
    // Sin el mensaje completo: el de Prisma puede copiar los valores (un secreto cifrado, una URL)
    errores(`No se pudo importar: ${resumirError(error)}`);
    return 2;
  } finally {
    await prisma.db.$disconnect();
  }
}

if (require.main === module) {
  void importarArchivo(
    process.argv[2],
    (linea) => console.log(linea),
    (linea) => console.error(linea),
  ).then((codigo) => process.exit(codigo));
}
