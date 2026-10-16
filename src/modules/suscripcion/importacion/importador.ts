import { isUUID } from 'class-validator';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditoriaSuscripciones } from '../../auditoria/auditoria.service';
import { CifradoSecreto } from '../../compartido/cifrado-secreto';
import { esEventoWebhook, EVENTOS_WEBHOOK, EventoWebhook } from '../../compartido/eventos-webhook';
import { SuscripcionRepository } from '../suscripcion.repository';

/**
 * Una línea del archivo de migración (JSON Lines, una suscripción por línea), tal como la
 * exportará el core en la fase 5b. Formato en docs/MIGRACION.md.
 */
export interface LineaSuscripcion {
  id: string;
  idPropietario: string;
  url: string;
  /** El secreto cifrado por el core, `v1.<base64url>`: se guarda tal cual, sin descifrarlo. */
  secretoCifrado: string;
  eventos: EventoWebhook[];
  activo: boolean;
  /** Opcional: la fecha de alta en el core (ISO 8601 UTC), para conservar el orden de GET. */
  fechaCreacion?: Date;
}

export type Desenlace = 'importada' | 'existente' | 'rechazada';

export interface ResultadoLinea {
  /** Número de línea en el archivo (1 la primera). */
  linea: number;
  desenlace: Desenlace;
  /** Por qué se rechazó: nombra el campo, nunca su valor (ni la URL ni el secreto). */
  motivo?: string;
}

export interface ResumenImportacion {
  importadas: number;
  existentes: number;
  rechazadas: number;
  lineas: ResultadoLinea[];
}

const CAMPOS = ['id', 'idPropietario', 'url', 'secretoCifrado', 'eventos', 'activo'];
const CAMPOS_OPCIONALES = ['fechaCreacion'];
const URL_VALIDA = /^https?:\/\/\S+$/;

/** Lee una línea; devuelve la suscripción o el motivo del rechazo (sin valores). */
export function interpretarLinea(texto: string, ahora: Date): LineaSuscripcion | string {
  let valor: unknown;
  try {
    valor = JSON.parse(texto);
  } catch {
    return 'no es JSON';
  }
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return 'no es un objeto JSON';
  }
  const fila = valor as Record<string, unknown>;
  const desconocidos = Object.keys(fila).filter(
    (c) => !CAMPOS.includes(c) && !CAMPOS_OPCIONALES.includes(c),
  );
  if (desconocidos.length > 0) return `campos que el formato no tiene (${desconocidos.length})`;
  const faltantes = CAMPOS.filter((c) => fila[c] === undefined);
  if (faltantes.length > 0) return `faltan campos: ${faltantes.join(', ')}`;

  const { id, idPropietario, url, secretoCifrado, eventos, activo, fechaCreacion } = fila;
  if (typeof id !== 'string' || !isUUID(id)) return 'id: debe ser un uuid';
  if (
    typeof idPropietario !== 'string' ||
    idPropietario.trim() === '' ||
    idPropietario.length > 200
  ) {
    return 'idPropietario: debe ser un texto de 1 a 200 caracteres';
  }
  if (typeof url !== 'string' || !URL_VALIDA.test(url) || url.length > 2048) {
    return 'url: debe ser una URL http(s) sin espacios de hasta 2048 caracteres';
  }
  if (typeof secretoCifrado !== 'string' || !/^v1\.[A-Za-z0-9_-]{40,}$/.test(secretoCifrado)) {
    return 'secretoCifrado: debe estar en el formato v1.<base64url> del core';
  }
  if (
    !Array.isArray(eventos) ||
    eventos.length === 0 ||
    !eventos.every(esEventoWebhook) ||
    new Set(eventos).size !== eventos.length
  ) {
    return `eventos: debe ser una lista sin repetidos de: ${EVENTOS_WEBHOOK.join(', ')}`;
  }
  if (typeof activo !== 'boolean') return 'activo: debe ser true o false';

  let fecha: Date | undefined;
  if (fechaCreacion !== undefined) {
    fecha = typeof fechaCreacion === 'string' ? new Date(fechaCreacion) : new Date(NaN);
    if (Number.isNaN(fecha.getTime()) || fecha > ahora) {
      return 'fechaCreacion: debe ser una fecha ISO 8601 que no esté en el futuro';
    }
  }
  return {
    id,
    idPropietario,
    url,
    secretoCifrado,
    eventos: EVENTOS_WEBHOOK.filter((tipo) => eventos.includes(tipo)),
    activo,
    ...(fecha === undefined ? {} : { fechaCreacion: fecha }),
  };
}

/**
 * Importa las suscripciones que exporta el core (npm run suscripciones:importar). Idempotente:
 * una suscripción cuyo id ya existe no se toca (cuenta como "ya existía"), así que correrlo dos
 * veces con el mismo archivo no cambia nada.
 *
 * Cada línea va en su propia transacción, con su registro de auditoría (SUSCRIPCION_IMPORTADA,
 * con el motivo IMPORTADA_INACTIVA si llega dada de baja). Una línea se rechaza si no cumple el
 * formato, si su secreto no se puede descifrar con la WEBHOOK_SECRET_KEY de este servicio (no
 * se podría firmar ninguna entrega) o si el dueño ya tiene otra suscripción activa con esa URL.
 * El secreto se guarda tal como viene: el formato es el mismo y la clave también.
 */
export class ImportadorSuscripciones {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repositorio: SuscripcionRepository,
    private readonly cifrado: CifradoSecreto,
    private readonly auditoria: AuditoriaSuscripciones,
    private readonly ahora: () => Date = () => new Date(),
  ) {}

  async importar(lineas: readonly string[]): Promise<ResumenImportacion> {
    const resultados: ResultadoLinea[] = [];
    for (const [indice, texto] of lineas.entries()) {
      if (texto.trim() === '') continue;
      resultados.push({ linea: indice + 1, ...(await this.importarLinea(texto)) });
    }
    const contar = (d: Desenlace) => resultados.filter((r) => r.desenlace === d).length;
    return {
      importadas: contar('importada'),
      existentes: contar('existente'),
      rechazadas: contar('rechazada'),
      lineas: resultados,
    };
  }

  private async importarLinea(texto: string): Promise<Omit<ResultadoLinea, 'linea'>> {
    const ahora = this.ahora();
    const linea = interpretarLinea(texto, ahora);
    if (typeof linea === 'string') return { desenlace: 'rechazada', motivo: linea };
    try {
      this.cifrado.descifrar(linea.secretoCifrado);
    } catch {
      return {
        desenlace: 'rechazada',
        motivo: 'secretoCifrado: no se puede descifrar con la WEBHOOK_SECRET_KEY actual',
      };
    }

    try {
      return await this.prisma.transaccion(async (tx) => {
        if (await this.repositorio.existe(tx, linea.id)) return { desenlace: 'existente' };
        if (
          linea.activo &&
          (await this.repositorio.tieneUrlActiva(tx, linea.idPropietario, linea.url, linea.id))
        ) {
          return {
            desenlace: 'rechazada',
            motivo: 'url: el dueño ya tiene otra suscripción activa con esa URL',
          };
        }
        await this.repositorio.crear(tx, {
          id: linea.id,
          idPropietario: linea.idPropietario,
          url: linea.url,
          secretoCifrado: linea.secretoCifrado,
          eventos: linea.eventos,
          activo: linea.activo,
          fecha: ahora,
          fechaCreacion: linea.fechaCreacion,
        });
        await this.auditoria.registrar(
          tx,
          {
            accion: 'SUSCRIPCION_IMPORTADA',
            suscripcionId: linea.id,
            idPropietario: linea.idPropietario,
            url: linea.url,
            eventos: linea.eventos,
            ...(linea.activo ? {} : { motivo: 'IMPORTADA_INACTIVA' as const }),
          },
          ahora,
        );
        return { desenlace: 'importada' };
      });
    } catch (error) {
      // Otra importación simultánea la creó primero (mismo id) o tomó la URL: se vuelve a mirar
      if ((error as { code?: unknown }).code === 'P2002') {
        const existe = await this.prisma.transaccion((tx) => this.repositorio.existe(tx, linea.id));
        return existe
          ? { desenlace: 'existente' }
          : {
              desenlace: 'rechazada',
              motivo: 'url: el dueño ya tiene otra suscripción activa con esa URL',
            };
      }
      throw error;
    }
  }
}
