import { EVENTOS } from '../../compartido/eventos-webhook';

/**
 * Reglas de compatibilidad de los esquemas de eventos (contracts/events/<tipo>.v<mayor>.json),
 * las de docs/EVENTOS.md. Las usan `npm run eventos:breaking` (compara con main en cada pull
 * request) y el arranque del servicio (que se niega a cargar un archivo mal formado).
 *
 * Un esquema describe lo que el core publica y lo que el tercero recibe. Dentro de un mismo
 * mayor (v1) solo se permite lo que no rompe a ninguno de los dos:
 *
 * - compatible: agregar un campo opcional, agregar un valor a un enum (por ejemplo
 *   schemaVersion "1.1"), cambiar textos (title, description, examples).
 * - incompatible: quitar o renombrar un campo, volver obligatorio uno opcional (o uno nuevo),
 *   dejar de garantizar uno obligatorio, quitar un valor de un enum, cambiar el tipo, el formato,
 *   el patrón, un largo o cualquier otra restricción, o borrar el archivo de una versión.
 *
 * Un cambio incompatible va en un archivo nuevo (<tipo>.v2.json, schemaVersion "2.0"), que
 * convive con el v1 mientras el core publique los dos.
 */

export type Gravedad = 'incompatible' | 'compatible';

export interface Cambio {
  gravedad: Gravedad;
  /** Dónde: `data.pnr`, `schemaVersion`... (vacío: la raíz del esquema). */
  ruta: string;
  motivo: string;
}

/** Un esquema JSON tal como está en el archivo (un objeto cualquiera). */
export type Esquema = Record<string, unknown>;

/** Palabras que solo documentan: cambiarlas no cambia lo que se acepta. */
const ANOTACIONES = new Set(['$schema', '$id', '$comment', 'title', 'description', 'examples']);

/** Palabras que se comparan por separado (las demás, por igualdad). */
const ESTRUCTURALES = new Set(['properties', 'required', 'enum', 'items']);

/** `booking.confirmed.v1.json` → tipo y mayor. */
export const FORMATO_ARCHIVO = /^([a-z_]+\.[a-z_]+)\.v([1-9][0-9]{0,2})\.json$/;

/** `1.0`, `1.12`, `2.0`... */
export const FORMATO_VERSION = /^([1-9][0-9]{0,2})\.([0-9]{1,3})$/;

/** Compara dos versiones de un mismo archivo; devuelve todo cambio que no sea solo documentación. */
export function compararEsquemas(antes: Esquema, despues: Esquema, ruta = ''): Cambio[] {
  const cambios: Cambio[] = [];
  const claves = new Set([...Object.keys(antes), ...Object.keys(despues)]);

  for (const clave of claves) {
    if (ANOTACIONES.has(clave) || ESTRUCTURALES.has(clave)) continue;
    if (!igual(antes[clave], despues[clave])) {
      cambios.push(incompatible(ruta, `cambió "${clave}" (una restricción del campo)`));
    }
  }

  cambios.push(...compararEnum(antes, despues, ruta));
  cambios.push(...compararPropiedades(antes, despues, ruta));
  if (esObjeto(antes.items) || esObjeto(despues.items)) {
    if (!esObjeto(antes.items) || !esObjeto(despues.items)) {
      cambios.push(incompatible(ruta, 'cambió "items"'));
    } else {
      cambios.push(...compararEsquemas(antes.items, despues.items, `${ruta}[]`));
    }
  }
  return cambios;
}

function compararEnum(antes: Esquema, despues: Esquema, ruta: string): Cambio[] {
  const previo = antes.enum;
  const nuevo = despues.enum;
  if (previo === undefined && nuevo === undefined) return [];
  if (!Array.isArray(previo) || !Array.isArray(nuevo)) {
    return [incompatible(ruta, previo === undefined ? 'se agregó "enum"' : 'se quitó "enum"')];
  }
  const cambios: Cambio[] = [];
  for (const valor of previo.filter((v) => !nuevo.some((n) => igual(n, v)))) {
    cambios.push(incompatible(ruta, `se quitó el valor ${JSON.stringify(valor)} del enum`));
  }
  for (const valor of nuevo.filter((v) => !previo.some((p) => igual(p, v)))) {
    cambios.push(compatible(ruta, `se agregó el valor ${JSON.stringify(valor)} al enum`));
  }
  return cambios;
}

function compararPropiedades(antes: Esquema, despues: Esquema, ruta: string): Cambio[] {
  const previas = esObjeto(antes.properties) ? antes.properties : {};
  const nuevas = esObjeto(despues.properties) ? despues.properties : {};
  const obligatoriasAntes = listaDeTextos(antes.required);
  const obligatoriasDespues = listaDeTextos(despues.required);
  const cambios: Cambio[] = [];

  for (const [nombre, previa] of Object.entries(previas)) {
    const campo = unir(ruta, nombre);
    const nueva = nuevas[nombre];
    if (nueva === undefined) {
      cambios.push(incompatible(campo, 'se quitó (o se renombró) el campo'));
      continue;
    }
    if (!obligatoriasAntes.includes(nombre) && obligatoriasDespues.includes(nombre)) {
      cambios.push(incompatible(campo, 'el campo se volvió obligatorio'));
    }
    if (obligatoriasAntes.includes(nombre) && !obligatoriasDespues.includes(nombre)) {
      cambios.push(
        incompatible(campo, 'el campo dejó de ser obligatorio (el tercero contaba con él)'),
      );
    }
    if (esObjeto(previa) && esObjeto(nueva)) {
      cambios.push(...compararEsquemas(previa, nueva, campo));
    } else if (!igual(previa, nueva)) {
      cambios.push(incompatible(campo, 'cambió la definición del campo'));
    }
  }

  for (const nombre of Object.keys(nuevas).filter((n) => !(n in previas))) {
    const campo = unir(ruta, nombre);
    cambios.push(
      obligatoriasDespues.includes(nombre)
        ? incompatible(campo, 'campo nuevo obligatorio')
        : compatible(campo, 'campo opcional nuevo'),
    );
  }

  // Un nombre en `required` sin su definición también cuenta
  for (const nombre of obligatoriasDespues.filter((n) => !(n in nuevas) && !(n in previas))) {
    if (!obligatoriasAntes.includes(nombre)) {
      cambios.push(incompatible(unir(ruta, nombre), 'campo nuevo obligatorio'));
    }
  }
  return cambios;
}

/**
 * Lo que tiene que cumplir un archivo de contracts/events por sí solo: nombre `<tipo>.v<mayor>.json`,
 * un tipo de los 15 del contrato v2, un `$id` que termina en ese nombre, `eventType` con ese único
 * valor, versiones `<mayor>.<menor>` de ese mayor, y el sobre completo (los seis campos
 * obligatorios, sin campos de más).
 */
export function problemasDeArchivo(nombre: string, esquema: unknown): string[] {
  const partes = FORMATO_ARCHIVO.exec(nombre);
  if (!partes) return [`${nombre}: el nombre debe ser <tipo>.v<mayor>.json`];
  const [, tipo, mayor] = partes;
  const problemas: string[] = [];
  if (!(EVENTOS as readonly string[]).includes(tipo)) {
    problemas.push(`${nombre}: ${tipo} no es uno de los 15 tipos de evento del contrato v2`);
  }
  if (!esObjeto(esquema)) return [...problemas, `${nombre}: no es un objeto JSON`];
  // Al copiar la v1 para hacer la v2 es fácil olvidarlo, y dos archivos con el mismo $id chocan
  if (
    esquema.$id !== undefined &&
    (typeof esquema.$id !== 'string' || !esquema.$id.endsWith(`/${nombre}`))
  ) {
    problemas.push(`${nombre}: el $id debe terminar en /${nombre}`);
  }

  const propiedades = esObjeto(esquema.properties) ? esquema.properties : {};
  const tipoEvento = propiedades.eventType;
  if (!esObjeto(tipoEvento) || !igual(tipoEvento.enum, [tipo])) {
    problemas.push(`${nombre}: properties.eventType.enum debe ser exactamente ["${tipo}"]`);
  }
  const version = propiedades.schemaVersion;
  const versiones = esObjeto(version) && Array.isArray(version.enum) ? version.enum : [];
  if (versiones.length === 0) {
    problemas.push(
      `${nombre}: properties.schemaVersion.enum debe listar las versiones (${mayor}.0...)`,
    );
  }
  for (const v of versiones) {
    const formato = typeof v === 'string' ? FORMATO_VERSION.exec(v) : null;
    if (!formato || formato[1] !== mayor) {
      problemas.push(`${nombre}: la versión ${JSON.stringify(v)} no es ${mayor}.<menor>`);
    }
  }
  const obligatorios = listaDeTextos(esquema.required);
  for (const campo of ['eventId', 'eventType', 'schemaVersion', 'occurredAt', 'ownerId', 'data']) {
    if (!obligatorios.includes(campo) || !(campo in propiedades)) {
      problemas.push(`${nombre}: el sobre debe declarar y exigir "${campo}"`);
    }
  }
  if (esquema.additionalProperties !== false) {
    problemas.push(`${nombre}: el sobre debe llevar additionalProperties: false`);
  }
  const data = propiedades.data;
  if (!esObjeto(data) || data.additionalProperties !== false) {
    problemas.push(
      `${nombre}: data debe llevar additionalProperties: false (nada sin declarar llega al tercero)`,
    );
  }
  return problemas;
}

function incompatible(ruta: string, motivo: string): Cambio {
  return { gravedad: 'incompatible', ruta, motivo };
}

function compatible(ruta: string, motivo: string): Cambio {
  return { gravedad: 'compatible', ruta, motivo };
}

function unir(ruta: string, nombre: string): string {
  return ruta === '' ? nombre : `${ruta}.${nombre}`;
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function listaDeTextos(valor: unknown): string[] {
  return Array.isArray(valor) ? valor.filter((v): v is string => typeof v === 'string') : [];
}

/** Igualdad estructural de dos valores JSON (el orden de las claves no importa). */
export function igual(a: unknown, b: unknown): boolean {
  return canonico(a) === canonico(b);
}

/** JSON con las claves ordenadas: el mismo valor da siempre el mismo texto. */
export function canonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (esObjeto(valor)) {
    const claves = Object.keys(valor).sort();
    return `{${claves.map((c) => `${JSON.stringify(c)}:${canonico(valor[c])}`).join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'null';
}
