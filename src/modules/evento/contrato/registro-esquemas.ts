import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ParametroInvalido } from '../../../common/errores/error-negocio';
import { EVENTOS_WEBHOOK, EventoWebhook, esEventoWebhook } from '../../compartido/eventos-webhook';
import { FORMATO_ARCHIVO, FORMATO_VERSION, problemasDeArchivo } from './compatibilidad';

/**
 * Carpeta de los esquemas, la misma desde src/ (pruebas) y desde dist/ (la imagen copia
 * contracts/events a /app/contracts/events): la raíz del repositorio está cuatro niveles arriba
 * de este archivo (src/modules/evento/contrato o dist/modules/evento/contrato).
 */
export const CARPETA_ESQUEMAS = resolve(__dirname, '..', '..', '..', '..', 'contracts', 'events');

/** El sobre que publica el core, ya validado contra el esquema de su tipo y versión. */
export interface SobreEvento {
  eventId: string;
  eventType: EventoWebhook;
  schemaVersion: string;
  occurredAt: string;
  ownerId: string;
  data: Record<string, unknown>;
}

export type ResultadoValidacion =
  | { valido: true; sobre: SobreEvento }
  | {
      valido: false;
      /** 400: el cuerpo no cumple el esquema; 422: tipo o versión que no se conocen. */
      status: 400 | 422;
      detalle: string;
      invalidParams: ParametroInvalido[];
    };

interface VersionMayor {
  versiones: string[];
  validar: ValidateFunction;
}

/** Un nombre de campo que se puede devolver sin riesgo (viene del cuerpo del publicador). */
const NOMBRE_SEGURO = /^[A-Za-z0-9_$.[\]-]{1,64}$/;

/** Los archivos de contracts/events no sirven: el servicio no arranca. */
export class EsquemasInvalidosError extends Error {
  constructor(problemas: string[]) {
    super(`Esquemas de eventos inválidos:\n${problemas.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EsquemasInvalidosError';
  }
}

/**
 * Los esquemas versionados de los eventos (contracts/events/<tipo>.v<mayor>.json), compilados
 * con Ajv al arrancar. Cada archivo cubre un mayor y lista en `schemaVersion.enum` los menores
 * que acepta. Los 12 tipos del contrato tienen que tener al menos su v1, o el servicio no
 * arranca: un tipo sin esquema no se podría publicar.
 *
 * Validar un sobre:
 *   - `eventType` que no es uno de los 12, o un `schemaVersion` sin esquema: 422.
 *   - Cualquier otro incumplimiento del esquema (un campo que falta, uno de más, un formato): 400,
 *     con un `invalidParams` por campo que nombra el campo y nunca repite su valor.
 */
export class RegistroEsquemas {
  private readonly porTipo = new Map<EventoWebhook, Map<string, VersionMayor>>();

  constructor(carpeta: string = CARPETA_ESQUEMAS) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv, ['uuid', 'date-time']);
    const problemas: string[] = [];

    for (const nombre of readdirSync(carpeta)
      .filter((n) => n.endsWith('.json'))
      .sort()) {
      let esquema: unknown;
      try {
        esquema = JSON.parse(readFileSync(join(carpeta, nombre), 'utf8'));
      } catch {
        problemas.push(`${nombre}: no es JSON`);
        continue;
      }
      const propios = problemasDeArchivo(nombre, esquema);
      if (propios.length > 0) {
        problemas.push(...propios);
        continue;
      }
      const [, tipo, mayor] = FORMATO_ARCHIVO.exec(nombre) as RegExpExecArray;
      const definicion = esquema as { properties: { schemaVersion: { enum: string[] } } };
      try {
        const validar = ajv.compile(esquema as object);
        const versiones = this.porTipo.get(tipo as EventoWebhook) ?? new Map();
        versiones.set(mayor, { versiones: definicion.properties.schemaVersion.enum, validar });
        this.porTipo.set(tipo as EventoWebhook, versiones);
      } catch (error) {
        problemas.push(`${nombre}: Ajv no lo compila (${(error as Error).message})`);
      }
    }

    for (const tipo of EVENTOS_WEBHOOK) {
      if (!this.porTipo.get(tipo)?.has('1')) problemas.push(`falta ${tipo}.v1.json`);
    }
    if (problemas.length > 0) throw new EsquemasInvalidosError(problemas);
  }

  /** Las versiones que se aceptan de un tipo, de la más vieja a la más nueva. */
  versionesDe(tipo: EventoWebhook): string[] {
    return [...(this.porTipo.get(tipo)?.values() ?? [])]
      .flatMap((m) => m.versiones)
      .sort(porVersion);
  }

  validar(cuerpo: unknown): ResultadoValidacion {
    if (typeof cuerpo !== 'object' || cuerpo === null || Array.isArray(cuerpo)) {
      return rechazo(400, [{ name: 'body', reason: 'must be a JSON object' }]);
    }
    const { eventType, schemaVersion } = cuerpo as Record<string, unknown>;
    if (typeof eventType !== 'string') {
      return rechazo(400, [{ name: 'eventType', reason: 'must be a string' }]);
    }
    if (!esEventoWebhook(eventType)) {
      return rechazo(422, [
        { name: 'eventType', reason: `unknown event type; known: ${EVENTOS_WEBHOOK.join(', ')}` },
      ]);
    }
    if (typeof schemaVersion !== 'string' || !FORMATO_VERSION.test(schemaVersion)) {
      return rechazo(400, [
        { name: 'schemaVersion', reason: 'must be a string like "1.0" (major.minor)' },
      ]);
    }
    const mayor = (FORMATO_VERSION.exec(schemaVersion) as RegExpExecArray)[1];
    const version = this.porTipo.get(eventType)?.get(mayor);
    if (version === undefined || !version.versiones.includes(schemaVersion)) {
      return rechazo(422, [
        {
          name: 'schemaVersion',
          reason: `unsupported version for this eventType; supported: ${this.versionesDe(eventType).join(', ')}`,
        },
      ]);
    }
    if (!version.validar(cuerpo)) {
      return rechazo(400, (version.validar.errors ?? []).map(aParametro));
    }
    return { valido: true, sobre: cuerpo as SobreEvento };
  }
}

function rechazo(status: 400 | 422, invalidParams: ParametroInvalido[]): ResultadoValidacion {
  const unicos = invalidParams.filter(
    (p, i) => invalidParams.findIndex((q) => q.name === p.name && q.reason === p.reason) === i,
  );
  const detalle = unicos.map(({ name, reason }) => `${name}: ${reason}`).join('; ');
  return {
    valido: false,
    status,
    detalle: detalle.length > 500 ? `${detalle.slice(0, 500)}…` : detalle,
    invalidParams: unicos,
  };
}

/**
 * Un error de Ajv como `invalidParams`: el nombre del campo (`data.pnr`) y el motivo de Ajv, que
 * describe la regla (`must match pattern ...`, `must be equal to one of the allowed values`) y
 * nunca repite el valor recibido.
 */
function aParametro(error: ErrorObject): ParametroInvalido {
  const ruta = error.instancePath
    .split('/')
    .filter((parte) => parte !== '')
    .join('.');
  const params = error.params as { missingProperty?: string; additionalProperty?: string };
  if (error.keyword === 'required' && params.missingProperty) {
    return { name: nombreSeguro(ruta, params.missingProperty), reason: 'is required' };
  }
  if (error.keyword === 'additionalProperties' && params.additionalProperty) {
    return {
      name: nombreSeguro(ruta, params.additionalProperty),
      reason: 'is not allowed by the schema',
    };
  }
  return { name: ruta === '' ? 'body' : ruta, reason: error.message ?? 'is invalid' };
}

function nombreSeguro(ruta: string, propiedad: string): string {
  const completo = ruta === '' ? propiedad : `${ruta}.${propiedad}`;
  return NOMBRE_SEGURO.test(completo) ? completo : `${ruta === '' ? 'body' : ruta}.(campo)`;
}

function porVersion(a: string, b: string): number {
  const [am, an] = a.split('.').map(Number);
  const [bm, bn] = b.split('.').map(Number);
  return am - bm || an - bn;
}
