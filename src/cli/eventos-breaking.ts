/**
 * Compara los esquemas de eventos (contracts/events/*.json) con los de otra rama y falla si
 * hay un cambio incompatible dentro de una misma versión mayor (reglas de docs/EVENTOS.md):
 *
 *   npm run eventos:breaking                 # contra origin/main
 *   npm run eventos:breaking -- origin/otra  # contra otra referencia de git
 *
 * Sale con 0 si todo es compatible, 1 si hay algún cambio incompatible y 2 si no pudo comparar
 * (la referencia no existe: `git fetch origin main`). Corre en los pull requests del CI.
 *
 * También revisa cada archivo por sí solo (nombre, tipo, versiones, sobre completo): un archivo
 * mal formado tampoco pasa.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Cambio,
  compararEsquemas,
  Esquema,
  problemasDeArchivo,
} from '../modules/evento/contrato/compatibilidad';

const CARPETA = 'contracts/events';

export interface ResultadoComparacion {
  /** Por archivo: los cambios encontrados (vacío si no cambió nada que importe). */
  cambios: Map<string, Cambio[]>;
  /** Problemas de forma de los archivos actuales. */
  problemas: string[];
  incompatible: boolean;
}

/**
 * Compara los archivos de la base (nombre → esquema) con los actuales. Es la lógica del CLI sin
 * git ni disco, para poder probarla.
 */
export function compararCarpetas(
  base: Map<string, Esquema>,
  actuales: Map<string, Esquema>,
): ResultadoComparacion {
  const cambios = new Map<string, Cambio[]>();
  const problemas: string[] = [];

  for (const [nombre, esquema] of actuales) problemas.push(...problemasDeArchivo(nombre, esquema));

  for (const [nombre, anterior] of base) {
    const actual = actuales.get(nombre);
    if (actual === undefined) {
      cambios.set(nombre, [
        {
          gravedad: 'incompatible',
          ruta: '',
          motivo: 'se borró el archivo: esa versión deja de aceptarse',
        },
      ]);
      continue;
    }
    const encontrados = compararEsquemas(anterior, actual);
    if (encontrados.length > 0) cambios.set(nombre, encontrados);
  }
  for (const nombre of actuales.keys()) {
    if (!base.has(nombre)) {
      cambios.set(nombre, [
        { gravedad: 'compatible', ruta: '', motivo: 'archivo nuevo (tipo o versión mayor nueva)' },
      ]);
    }
  }

  const incompatible =
    problemas.length > 0 ||
    [...cambios.values()].some((lista) => lista.some((c) => c.gravedad === 'incompatible'));
  return { cambios, problemas, incompatible };
}

function git(...argumentos: string[]): string {
  return execFileSync('git', argumentos, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function leerBase(referencia: string): Map<string, Esquema> {
  const base = new Map<string, Esquema>();
  const listado = git('ls-tree', '--name-only', `${referencia}:${CARPETA}`)
    .split('\n')
    .filter((nombre) => nombre.endsWith('.json'));
  for (const nombre of listado) {
    base.set(nombre, JSON.parse(git('show', `${referencia}:${CARPETA}/${nombre}`)) as Esquema);
  }
  return base;
}

function leerActuales(): Map<string, Esquema> {
  const actuales = new Map<string, Esquema>();
  if (!existsSync(CARPETA)) return actuales;
  for (const nombre of readdirSync(CARPETA)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    actuales.set(nombre, JSON.parse(readFileSync(join(CARPETA, nombre), 'utf8')) as Esquema);
  }
  return actuales;
}

function principal(): number {
  const referencia = process.argv[2] ?? process.env.EVENTOS_BASE ?? 'origin/main';
  try {
    git('rev-parse', '--verify', '--quiet', `${referencia}^{commit}`);
  } catch {
    console.error(`No existe la referencia ${referencia}. Prueba: git fetch origin main`);
    return 2;
  }

  let base: Map<string, Esquema>;
  try {
    base = leerBase(referencia);
  } catch {
    // La base todavía no tiene contracts/events: todo lo de ahora es nuevo
    base = new Map();
  }
  const { cambios, problemas, incompatible } = compararCarpetas(base, leerActuales());

  console.log(`Esquemas de eventos contra ${referencia}:`);
  for (const problema of problemas) console.log(`  ✖ ${problema}`);
  if (cambios.size === 0 && problemas.length === 0) console.log('  sin cambios');
  for (const [nombre, lista] of [...cambios.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const cambio of lista) {
      const marca = cambio.gravedad === 'incompatible' ? '✖ incompatible' : '✓ compatible  ';
      const donde = cambio.ruta === '' ? '' : ` ${cambio.ruta}:`;
      console.log(`  ${marca} ${nombre}${donde} ${cambio.motivo}`);
    }
  }
  if (incompatible) {
    console.log(
      '\nHay cambios incompatibles: van en una versión mayor nueva (<tipo>.v2.json, ' +
        'schemaVersion "2.0") que conviva con la v1. Ver docs/EVENTOS.md.',
    );
    return 1;
  }
  console.log('\nTodo compatible.');
  return 0;
}

if (require.main === module) {
  process.exit(principal());
}
