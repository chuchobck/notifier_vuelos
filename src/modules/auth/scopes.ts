/**
 * Scopes (`scope` del token) que este servicio conoce. Los emite identity_vuelos; este servicio
 * no los recalcula, solo los exige con `@Scopes(...)`:
 *
 * - `flights:webhooks`: gestionar las propias suscripciones (GET, POST y DELETE /webhooks), el
 *   scope que el contrato del core declara para esas operaciones.
 * - `events:publish`: publicar eventos en POST /internal/v1/events. Solo para el core, con un
 *   cliente OAuth (client_credentials): el token de una persona no puede publicar aunque lo trajera.
 *
 * Los demás `flights:*` están para que el token de una persona (que los trae) no deje avisos de
 * "scope desconocido" en el log; ninguna ruta de aquí los exige.
 *
 * `events:publish` no existe todavía en identity_vuelos (su SCOPES, `cliente:crear` y el CHECK
 * ck_cliente_oauth_scopes solo admiten los 6 `flights:*`): ver docs/PLAN.md, Pendientes.
 */
export const SCOPES = [
  'flights:read',
  'flights:hold',
  'flights:book',
  'flights:cancel',
  'flights:webhooks',
  'flights:admin',
  'events:publish',
] as const;

export type Scope = (typeof SCOPES)[number];

/** Gestionar las propias suscripciones a webhooks. */
export const SCOPE_WEBHOOKS: Scope = 'flights:webhooks';

/** Publicar eventos (solo el core, con un cliente OAuth). */
export const SCOPE_PUBLICAR_EVENTOS: Scope = 'events:publish';
