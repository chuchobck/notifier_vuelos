import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TipoEvento } from '../../src/modules/compartido/eventos-webhook';

/**
 * El contrato de Vuelos v2 del core (contracts/vuelos-openapi-v2.yaml de backend_vuelos, main
 * b350502), copiado TAL CUAL en test/contratos/. Las pruebas validan contra sus components.schemas
 * lo que este servicio entrega y responde en /api/v2: VuelosCloudEvent y el Event* de cada tipo,
 * WebhookSubscription, VuelosEventosResponse y ProblemDetails.
 *
 * OpenAPI 3.0 no es JSON Schema: `nullable: true` se lleva a `type: [t, "null"]` antes de compilar
 * (lo demás que Ajv no conoce, como `example` o `readOnly`, se ignora con strict: false).
 */
export const CONTRATO_V2 = join(__dirname, '..', 'contratos', 'vuelos-openapi-v2.yaml');

/**
 * Los tipos sin un Event* propio en el contrato (VuelosCloudEvent es un oneOf de 9 esquemas que no
 * los cubre): su CloudEvent se valida contra CloudEventBase. Anotado en docs/EVENTOS.md.
 */
export const TIPOS_SIN_ESQUEMA_PROPIO: readonly TipoEvento[] = [
  'booking.ticket_issuing',
  'booking.ticket_failed',
  'flight.schedule_changed',
  'flight.cancelled',
];

/** El Event* del contrato para cada tipo que tiene uno. */
const ESQUEMA_DE_TIPO: Partial<Record<TipoEvento, string>> = {
  'hold.created': 'EventHoldCreated',
  'hold.expired': 'EventHoldExpired',
  'booking.confirmed': 'EventBookingConfirmed',
  'booking.failed': 'EventBookingFailed',
  'booking.ticket_issued': 'EventTicketIssued',
  'booking.changed': 'EventBookingChanged',
  'booking.baggage_added': 'EventBookingChanged',
  'booking.seat_changed': 'EventBookingChanged',
  'booking.cancelled': 'EventBookingCancelled',
  'booking.checked_in': 'EventCheckedIn',
  'flight.status_changed': 'EventFlightStatusChanged',
};

function conNulos(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(conNulos);
  if (typeof valor !== 'object' || valor === null) return valor;
  const objeto = Object.fromEntries(
    Object.entries(valor).map(([clave, v]) => [clave, conNulos(v)]),
  ) as Record<string, unknown>;
  if (objeto.nullable === true) {
    delete objeto.nullable;
    if (typeof objeto.type === 'string') objeto.type = [objeto.type, 'null'];
    if (Array.isArray(objeto.enum)) objeto.enum = [...objeto.enum, null];
  }
  return objeto;
}

/**
 * Para validar una RESPUESTA: una propiedad `writeOnly` (el `secret` de WebhookSubscription) no
 * se exige (OpenAPI 3.0: `required` con writeOnly vale solo en la petición).
 */
function paraRespuesta(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(paraRespuesta);
  if (typeof valor !== 'object' || valor === null) return valor;
  const objeto = Object.fromEntries(
    Object.entries(valor).map(([clave, v]) => [clave, paraRespuesta(v)]),
  ) as Record<string, unknown>;
  const propiedades = objeto.properties as Record<string, { writeOnly?: boolean }> | undefined;
  if (propiedades && Array.isArray(objeto.required)) {
    objeto.required = (objeto.required as string[]).filter((p) => !propiedades[p]?.writeOnly);
  }
  return objeto;
}

const documento = paraRespuesta(conNulos(load(readFileSync(CONTRATO_V2, 'utf8')))) as {
  components: { schemas: Record<string, unknown> };
};
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema({ $id: 'vuelos-v2', components: documento.components });

const cache = new Map<string, ValidateFunction>();
function validador(nombre: string): ValidateFunction {
  let v = cache.get(nombre);
  if (!v) {
    v = ajv.compile({ $ref: `vuelos-v2#/components/schemas/${nombre}` });
    cache.set(nombre, v);
  }
  return v;
}

/** Falla la prueba si `cuerpo` no cumple components.schemas[nombre] del contrato v2. */
export function esperarEsquemaV2(nombre: string, cuerpo: unknown): void {
  const validar = validador(nombre);
  const valido = validar(cuerpo);
  expect({ esquema: nombre, errores: validar.errors ?? [] }).toEqual({
    esquema: nombre,
    errores: [],
  });
  expect(valido).toBe(true);
}

/**
 * Falla la prueba si el CloudEvent no cumple el contrato v2: VuelosCloudEvent y el Event* de su
 * tipo; para los 4 tipos sin Event* propio, CloudEventBase.
 */
export function esperarCloudEventV2(tipo: TipoEvento, cuerpo: unknown): void {
  const propio = ESQUEMA_DE_TIPO[tipo];
  if (propio === undefined) {
    expect(TIPOS_SIN_ESQUEMA_PROPIO).toContain(tipo);
    esperarEsquemaV2('CloudEventBase', cuerpo);
    return;
  }
  esperarEsquemaV2('VuelosCloudEvent', cuerpo);
  esperarEsquemaV2(propio, cuerpo);
}
