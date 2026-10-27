/**
 * Scopes (`scope` del token) que este servicio conoce. Los emite identity_vuelos; este servicio
 * no los recalcula, solo los exige con `@Scopes(...)`:
 *
 * - `flights:webhooks`: gestionar las propias suscripciones (GET, POST y DELETE de
 *   /flights/v1/webhooks y /api/v2/vuelos/webhooks), el scope que los dos contratos declaran.
 * - `flights:read`: leer el feed GET /api/v2/vuelos/eventos (contrato de Vuelos v2).
 * - `events:publish`: publicar eventos en POST /internal/v1/events. Solo para el core, con un
 *   cliente OAuth (client_credentials): el token de una persona no puede publicar aunque lo trajera.
 *
 * Los demás `flights:*` (también `flights:ops`, que identity emite desde su fase I2) están para que
 * un token que los trae no deje avisos de "scope desconocido" en el log; ninguna ruta de aquí los
 * exige.
 */
export const SCOPES = [
  'flights:read',
  'flights:hold',
  'flights:book',
  'flights:cancel',
  'flights:webhooks',
  'flights:ops',
  'flights:admin',
  'events:publish',
] as const;

export type Scope = (typeof SCOPES)[number];

/** Gestionar las propias suscripciones a webhooks. */
export const SCOPE_WEBHOOKS: Scope = 'flights:webhooks';

/** Publicar eventos (solo el core, con un cliente OAuth). */
export const SCOPE_PUBLICAR_EVENTOS: Scope = 'events:publish';
