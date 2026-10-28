-- =============================================================================
--  001 · Contrato v2 (fase N2): suscripciones con formato, 15 tipos de evento,
--  correlation_id y traceparent en cada evento, e índice del feed.
--  Idempotente: se puede correr dos veces sin cambiar nada (./db/migrar.sh).
-- =============================================================================

BEGIN;

SET search_path TO notificaciones;

-- Los 15 tipos (VuelosEventName del contrato v2): los 12 de v1 y los 3 nuevos al final
CREATE OR REPLACE FUNCTION fn_es_tipo_evento(p_tipo text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN p_tipo = ANY (ARRAY[
    'booking.confirmed',
    'booking.failed',
    'booking.changed',
    'booking.cancelled',
    'booking.baggage_added',
    'hold.expired',
    'flight.schedule_changed',
    'flight.cancelled',
    'booking.ticket_issuing',
    'booking.ticket_issued',
    'booking.ticket_failed',
    'booking.checked_in',
    'hold.created',
    'booking.seat_changed',
    'flight.status_changed'
]);
COMMENT ON FUNCTION fn_es_tipo_evento(text) IS 'Si el texto es uno de los 15 tipos de evento (VuelosEventName del contrato v2; los 12 primeros, los del contrato 1.5).';

-- Formato de la suscripción: las que ya existen se crearon por /flights/v1/webhooks
ALTER TABLE suscripcion ADD COLUMN IF NOT EXISTS formato text NOT NULL DEFAULT 'v1';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_suscripcion_formato') THEN
        ALTER TABLE suscripcion ADD CONSTRAINT ck_suscripcion_formato CHECK (formato IN ('v1', 'v2'));
    END IF;
END $$;
COMMENT ON COLUMN suscripcion.formato IS 'v1: se creó por /flights/v1/webhooks y recibe el WebhookPayload del contrato 1.5. v2: se creó por /api/v2/vuelos/webhooks y recibe CloudEvents 1.0. No cambia nunca.';

-- correlation_id: los eventos que ya existen no tenían uno; se les da uno fijo derivado del id
ALTER TABLE evento ADD COLUMN IF NOT EXISTS correlation_id text;
UPDATE evento SET correlation_id = 'corr-' || id_evento::text WHERE correlation_id IS NULL;
ALTER TABLE evento ALTER COLUMN correlation_id SET NOT NULL;
ALTER TABLE evento ADD COLUMN IF NOT EXISTS traceparent text;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_evento_correlation_id') THEN
        ALTER TABLE evento ADD CONSTRAINT ck_evento_correlation_id CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,100}$');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_evento_traceparent') THEN
        ALTER TABLE evento ADD CONSTRAINT ck_evento_traceparent CHECK (traceparent IS NULL OR traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');
    END IF;
END $$;
COMMENT ON COLUMN evento.correlation_id IS 'X-Correlation-Id del proceso que originó el hecho: el correlationId del sobre, si no el X-Correlation-Id de la publicación, si no uno generado. Va en el CloudEvent (correlationid) y en la cabecera de cada entrega.';
COMMENT ON COLUMN evento.traceparent IS 'traceparent del span SERVER que recibió el evento (continúa la traza del relevo del core): cada entrega abre su span CLIENT como hijo. Nunca se manda a un tercero.';

COMMENT ON TABLE entrega IS 'Bandeja de salida: una fila por evento y suscripción, con su propio reintento. No se borra ni se audita fila por fila: el resultado vive en la propia fila.';
COMMENT ON COLUMN entrega.cuerpo IS 'Lo que recibe el tercero (WebhookPayload v1 o CloudEvent v2, según la suscripción), congelado al recibir el evento: un reintento envía exactamente el mismo cuerpo.';

-- El feed: los eventos de un dueño en orden de llegada
DROP INDEX IF EXISTS ix_evento_propietario;
CREATE INDEX IF NOT EXISTS ix_evento_feed ON evento (id_propietario, id);

COMMIT;
