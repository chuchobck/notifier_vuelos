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
import { AuditoriaRepository } from '../modules/auditoria/auditoria.repository';
import { AuditoriaSuscripciones } from '../modules/auditoria/auditoria.service';
import { CifradoSecreto } from '../modules/compartido/cifrado-secreto';
import { ImportadorSuscripciones } from '../modules/suscripcion/importacion/importador';
import { SuscripcionRepository } from '../modules/suscripcion/suscripcion.repository';
import { PrismaService, resumirError } from '../prisma/prisma.service';
import { LARGO_MINIMO_WEBHOOK_KEY } from '../config/entorno';

async function principal(): Promise<number> {
  const archivo = process.argv[2];
  if (!archivo) {
    console.error('Uso: npm run suscripciones:importar -- <archivo.jsonl>');
    return 2;
  }
  if (!existsSync(archivo)) {
    console.error(`No existe el archivo ${basename(archivo)}`);
    return 2;
  }
  if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
  if (!process.env.DATABASE_URL) {
    console.error('Falta DATABASE_URL (en el entorno o en .env)');
    return 2;
  }
  if ((process.env.WEBHOOK_SECRET_KEY ?? '').length < LARGO_MINIMO_WEBHOOK_KEY) {
    console.error(
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
    const lineas = readFileSync(archivo, 'utf8').split(/\r?\n/);
    const resumen = await importador.importar(lineas);

    console.log(`Importación de suscripciones desde ${basename(archivo)}`);
    for (const r of resumen.lineas.filter((l) => l.desenlace === 'rechazada')) {
      console.log(`  línea ${r.linea}: rechazada (${r.motivo})`);
    }
    console.log(
      `Importadas: ${resumen.importadas} · ya existían: ${resumen.existentes} · ` +
        `rechazadas: ${resumen.rechazadas}`,
    );
    return resumen.rechazadas > 0 ? 1 : 0;
  } finally {
    await prisma.db.$disconnect();
  }
}

principal()
  .then((codigo) => process.exit(codigo))
  .catch((error: unknown) => {
    // Sin el mensaje completo: el de Prisma puede copiar los valores (un secreto cifrado, una URL)
    console.error(`No se pudo importar: ${resumirError(error)}`);
    process.exit(2);
  });
