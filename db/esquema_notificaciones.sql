-- =============================================================================
--  QUINDE · NOTIFIER - esquema "notificaciones"
-- -----------------------------------------------------------------------------
--  Motor objetivo : PostgreSQL 18 (corre sin cambios en 16 y 17)
--  Alcance        : suscripciones a webhooks (/flights/v1/webhooks del contrato
--                   GDS Flight Core API v1.5.0.0 y /api/v2/vuelos/webhooks del
--                   contrato de Vuelos v2), los eventos que publica el core, la
--                   bandeja de salida de las entregas y la auditoría de altas y
--                   bajas de suscripción.
--  Una base que ya existe se pone al día con ./db/migrar.sh (db/migraciones/):
--  este archivo y las migraciones dejan la misma base (lo comprueba el CI).
--  Extensiones    : ninguna (gen_random_uuid() es nativa desde PostgreSQL 13)
-- -----------------------------------------------------------------------------
--  CONVENCIONES (las del core y de identity)
--   * Nombres en español y snake_case.
--   * PK uuid en lo que viaja por la API; bigint IDENTITY en lo interno.
--   * Instantes en timestamptz (UTC). Las horas las pone la aplicación con su
--     Reloj (las pruebas lo adelantan); los DEFAULT now() son solo de respaldo.
--   * Eliminación lógica: una suscripción se da de baja con activo = false.
--     Nada se borra: ningún ON DELETE CASCADE.
--   * Ni el secreto en claro ni la URL completa salen de suscripcion: la
--     auditoría guarda solo el host del destino.
--
--  REINICIO EN DESARROLLO (borra solo este esquema): ./db/reset.sh
-- =============================================================================

BEGIN;

CREATE SCHEMA notificaciones;
COMMENT ON SCHEMA notificaciones IS 'Quinde · Notifier: suscripciones a webhooks, eventos recibidos del core y su entrega firmada.';

SET search_path TO notificaciones;


-- =============================================================================
-- 1. TIPOS
-- =============================================================================

CREATE TYPE estado_entrega AS ENUM ('PENDIENTE', 'ENTREGADO', 'FALLIDO');
COMMENT ON TYPE estado_entrega IS 'Ciclo de la entrega de un evento a una suscripción: PENDIENTE (por enviar o por reintentar), ENTREGADO (el receptor respondió 2xx) o FALLIDO (se agotaron los intentos o la suscripción ya no está activa).';

CREATE TYPE accion_auditoria AS ENUM (
    'SUSCRIPCION_CREADA',
    'SUSCRIPCION_ELIMINADA',
    'SUSCRIPCION_DESACTIVADA',
    'SUSCRIPCION_IMPORTADA'
);
COMMENT ON TYPE accion_auditoria IS 'SUSCRIPCION_CREADA (POST /webhooks), SUSCRIPCION_ELIMINADA (DELETE /webhooks/{id}), SUSCRIPCION_DESACTIVADA (baja automática del proceso de entrega) y SUSCRIPCION_IMPORTADA (npm run suscripciones:importar).';

-- Los 15 tipos de evento (VuelosEventName del contrato v2): los 12 de WebhookSubscription.events
-- del contrato 1.5 y los 3 de v2 al final. Es la misma lista de EVENTOS (src/modules/compartido/
-- eventos-webhook.ts) y de contracts/events: si una cambia, las otras cambian en el mismo paso.
CREATE FUNCTION fn_es_tipo_evento(p_tipo text) RETURNS boolean
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


-- =============================================================================
-- 2. SUSCRIPCIONES
-- =============================================================================

CREATE TABLE suscripcion (
    id                  uuid         NOT NULL DEFAULT gen_random_uuid(),
    id_propietario      text         NOT NULL,
    url                 text         NOT NULL,
    secreto_cifrado     text         NOT NULL,
    activo              boolean      NOT NULL DEFAULT true,
    fecha_creacion      timestamptz  NOT NULL DEFAULT now(),
    fecha_actualizacion timestamptz  NOT NULL DEFAULT now(),
    formato             text         NOT NULL DEFAULT 'v1',
    CONSTRAINT pk_suscripcion PRIMARY KEY (id),
    CONSTRAINT ck_suscripcion_propietario CHECK (btrim(id_propietario) <> '' AND length(id_propietario) <= 200),
    CONSTRAINT ck_suscripcion_url CHECK (url ~ '^https?://[^[:space:]]+$' AND length(url) <= 2048),
    -- El formato del core: v1.<base64url(nonce | etiqueta | cifrado)>. Nunca el secreto en claro.
    CONSTRAINT ck_suscripcion_secreto CHECK (secreto_cifrado ~ '^v1\.[A-Za-z0-9_-]{40,}$'),
    CONSTRAINT ck_suscripcion_fechas CHECK (fecha_actualizacion >= fecha_creacion),
    CONSTRAINT ck_suscripcion_formato CHECK (formato IN ('v1', 'v2'))
);

CREATE TABLE suscripcion_evento (
    id              bigint  GENERATED ALWAYS AS IDENTITY,
    suscripcion_id  uuid    NOT NULL,
    tipo_evento     text    NOT NULL,
    CONSTRAINT pk_suscripcion_evento PRIMARY KEY (id),
    CONSTRAINT uq_suscripcion_evento UNIQUE (suscripcion_id, tipo_evento),
    CONSTRAINT fk_suscripcion_evento_suscripcion FOREIGN KEY (suscripcion_id) REFERENCES suscripcion (id) ON DELETE RESTRICT,
    CONSTRAINT ck_suscripcion_evento_tipo CHECK (fn_es_tipo_evento(tipo_evento))
);


-- =============================================================================
-- 3. EVENTOS RECIBIDOS
-- =============================================================================

-- Un evento que publicó el core (POST /internal/v1/events). id_evento es el eventId del
-- sobre: único, así una repetición no duplica nada. payload es el `data` del sobre, ya
-- validado contra contracts/events/<tipo>.v<mayor>.json.
CREATE TABLE evento (
    id               bigint       GENERATED ALWAYS AS IDENTITY,
    id_evento        uuid         NOT NULL,
    tipo             text         NOT NULL,
    version_esquema  text         NOT NULL,
    id_propietario   text         NOT NULL,
    payload          jsonb        NOT NULL,
    ocurrido_en      timestamptz  NOT NULL,
    recibido_en      timestamptz  NOT NULL,
    huella           text         NOT NULL,
    publicado_por    text         NOT NULL,
    correlation_id   text         NOT NULL,
    traceparent      text,
    CONSTRAINT pk_evento PRIMARY KEY (id),
    CONSTRAINT uq_evento_id_evento UNIQUE (id_evento),
    CONSTRAINT ck_evento_tipo CHECK (fn_es_tipo_evento(tipo)),
    CONSTRAINT ck_evento_version CHECK (version_esquema ~ '^[1-9][0-9]{0,2}\.[0-9]{1,3}$'),
    CONSTRAINT ck_evento_propietario CHECK (btrim(id_propietario) <> '' AND length(id_propietario) <= 200),
    CONSTRAINT ck_evento_payload CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT ck_evento_huella CHECK (huella ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_evento_publicado_por CHECK (btrim(publicado_por) <> '' AND length(publicado_por) <= 200),
    CONSTRAINT ck_evento_correlation_id CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,100}$'),
    CONSTRAINT ck_evento_traceparent CHECK (traceparent IS NULL OR traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$')
);


-- =============================================================================
-- 4. ENTREGAS (bandeja de salida)
-- =============================================================================

-- Una fila por evento y suscripción, con su propio reintento. Se inserta en la misma
-- transacción que guarda el evento; el envío HTTP lo hace un proceso aparte (nunca dentro de
-- una transacción). cuerpo es lo que recibe el tercero según el formato de su suscripción (el
-- WebhookPayload v1 o el CloudEvent v2), congelado al recibir el evento.
CREATE TABLE entrega (
    id                  bigint          GENERATED ALWAYS AS IDENTITY,
    suscripcion_id      uuid            NOT NULL,
    id_evento           uuid            NOT NULL,
    cuerpo              jsonb           NOT NULL,
    estado              estado_entrega  NOT NULL DEFAULT 'PENDIENTE',
    intentos            smallint        NOT NULL DEFAULT 0,
    proximo_intento     timestamptz     NOT NULL,
    ultimo_codigo_http  smallint,
    ultimo_error        text,
    fecha_creacion      timestamptz     NOT NULL DEFAULT now(),
    fecha_actualizacion timestamptz     NOT NULL DEFAULT now(),
    CONSTRAINT pk_entrega PRIMARY KEY (id),
    CONSTRAINT uq_entrega_suscripcion_evento UNIQUE (suscripcion_id, id_evento),
    CONSTRAINT fk_entrega_suscripcion FOREIGN KEY (suscripcion_id) REFERENCES suscripcion (id) ON DELETE RESTRICT,
    CONSTRAINT fk_entrega_evento FOREIGN KEY (id_evento) REFERENCES evento (id_evento) ON DELETE RESTRICT,
    CONSTRAINT ck_entrega_intentos CHECK (intentos BETWEEN 0 AND 20),
    CONSTRAINT ck_entrega_codigo_http CHECK (ultimo_codigo_http IS NULL OR ultimo_codigo_http BETWEEN 100 AND 599),
    CONSTRAINT ck_entrega_entregado CHECK (estado <> 'ENTREGADO' OR (ultimo_codigo_http BETWEEN 200 AND 299 AND intentos >= 1)),
    CONSTRAINT ck_entrega_error CHECK (ultimo_error IS NULL OR ultimo_error ~ '^[A-Z0-9_]{2,40}$'),
    CONSTRAINT ck_entrega_cuerpo CHECK (jsonb_typeof(cuerpo) = 'object')
);


-- =============================================================================
-- 5. AUDITORÍA DE SUSCRIPCIONES
-- =============================================================================

-- Altas y bajas de suscripciones. Sin secreto (ni cifrado) y sin la URL: solo su host. Es de
-- solo inserción (fn_auditoria_inmutable).
CREATE TABLE auditoria (
    id              bigint            GENERATED ALWAYS AS IDENTITY,
    fecha           timestamptz       NOT NULL DEFAULT now(),
    accion          accion_auditoria  NOT NULL,
    suscripcion_id  uuid              NOT NULL,
    id_propietario  text              NOT NULL,
    actor           text,
    host_destino    text,
    eventos         text[]            NOT NULL DEFAULT '{}',
    motivo          text,
    direccion_ip    inet,
    id_peticion     text,
    CONSTRAINT pk_auditoria PRIMARY KEY (id),
    CONSTRAINT fk_auditoria_suscripcion FOREIGN KEY (suscripcion_id) REFERENCES suscripcion (id) ON DELETE RESTRICT,
    -- Sin repetición {1,300}: PostgreSQL no admite más de 255 en una expresión regular
    CONSTRAINT ck_auditoria_host CHECK (host_destino IS NULL OR (host_destino ~ '^[^/?#@[:space:]]+$' AND length(host_destino) <= 300)),
    CONSTRAINT ck_auditoria_motivo CHECK (motivo IS NULL OR motivo ~ '^[A-Z0-9_]{2,40}$'),
    CONSTRAINT ck_auditoria_id_peticion CHECK (id_peticion IS NULL OR id_peticion ~ '^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$')
);

CREATE FUNCTION fn_auditoria_inmutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'La tabla auditoria es de solo inserción'
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER tg_auditoria_inmutable
    BEFORE UPDATE OR DELETE ON auditoria
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria_inmutable();

CREATE TRIGGER tg_auditoria_sin_truncate
    BEFORE TRUNCATE ON auditoria
    FOR EACH STATEMENT EXECUTE FUNCTION fn_auditoria_inmutable();


-- =============================================================================
-- 6. ÍNDICES
-- =============================================================================

-- Una URL activa no se repite por dueño (409 en POST /webhooks), como en el core
CREATE UNIQUE INDEX uq_suscripcion_propietario_url ON suscripcion (id_propietario, url) WHERE activo;
CREATE INDEX ix_suscripcion_propietario ON suscripcion (id_propietario, fecha_creacion) WHERE activo;
-- El reparto: suscripciones de un tipo de evento
CREATE INDEX ix_suscripcion_evento_tipo ON suscripcion_evento (tipo_evento, suscripcion_id);
-- El feed (GET /api/v2/vuelos/eventos): los eventos de un dueño en orden de llegada, por cursor
CREATE INDEX ix_evento_feed ON evento (id_propietario, id);
-- El proceso de entrega toma las pendientes cuya hora llegó
CREATE INDEX ix_entrega_pendiente ON entrega (proximo_intento, id) WHERE estado = 'PENDIENTE';
-- La racha de fallidas de una suscripción (baja automática)
CREATE INDEX ix_entrega_suscripcion ON entrega (suscripcion_id, fecha_actualizacion DESC) WHERE estado <> 'PENDIENTE';
CREATE INDEX ix_entrega_evento ON entrega (id_evento);
CREATE INDEX ix_auditoria_suscripcion ON auditoria (suscripcion_id, fecha);
CREATE INDEX ix_auditoria_fecha ON auditoria (fecha);


-- =============================================================================
-- 7. COMENTARIOS
-- =============================================================================

COMMENT ON TABLE suscripcion IS 'Suscripción de un integrador a webhooks (WebhookSubscription del contrato). Baja lógica con activo = false.';
COMMENT ON TABLE suscripcion_evento IS 'Tipos de evento que escucha cada suscripción. No tiene API propia: la maneja el service de suscripcion.';
COMMENT ON TABLE evento IS 'Eventos publicados por el core (POST /internal/v1/events). id_evento único: publicar dos veces el mismo no duplica nada.';
COMMENT ON TABLE entrega IS 'Bandeja de salida: una fila por evento y suscripción, con su propio reintento. No se borra ni se audita fila por fila: el resultado vive en la propia fila.';
COMMENT ON TABLE auditoria IS 'Altas y bajas de suscripciones, de solo inserción. Nunca el secreto ni la URL completa.';

COMMENT ON COLUMN suscripcion.id_propietario IS 'sub del token que la creó (persona o cliente OAuth de identity_vuelos). Es el ownerId de los eventos.';
COMMENT ON COLUMN suscripcion.formato IS 'v1: se creó por /flights/v1/webhooks y recibe el WebhookPayload del contrato 1.5. v2: se creó por /api/v2/vuelos/webhooks y recibe CloudEvents 1.0. No cambia nunca.';
COMMENT ON COLUMN suscripcion.secreto_cifrado IS 'AES-256-GCM con clave derivada por HKDF de WEBHOOK_SECRET_KEY, formato v1.<base64url>: el mismo del core, para migrar sin que el tercero cambie nada.';
COMMENT ON COLUMN evento.id_evento IS 'eventId del sobre y del WebhookPayload: el mismo para todas las suscripciones que lo reciben. El receptor lo usa (X-Webhook-Id) para no procesar dos veces.';
COMMENT ON COLUMN evento.version_esquema IS 'schemaVersion del sobre (1.0...). El mayor elige el archivo contracts/events/<tipo>.v<mayor>.json.';
COMMENT ON COLUMN evento.payload IS 'El data del sobre, tal como se validó.';
COMMENT ON COLUMN evento.ocurrido_en IS 'occurredAt del sobre: cuándo pasó el hecho en el core.';
COMMENT ON COLUMN evento.recibido_en IS 'Cuándo lo recibió este servicio (Reloj de la aplicación).';
COMMENT ON COLUMN evento.huella IS 'SHA-256 del sobre canónico: una repetición con el mismo eventId y otro contenido es un 409.';
COMMENT ON COLUMN evento.publicado_por IS 'client_id del token que lo publicó.';
COMMENT ON COLUMN evento.correlation_id IS 'X-Correlation-Id del proceso que originó el hecho: el correlationId del sobre, si no el X-Correlation-Id de la publicación, si no uno generado. Va en el CloudEvent (correlationid) y en la cabecera de cada entrega.';
COMMENT ON COLUMN evento.traceparent IS 'traceparent del span SERVER que recibió el evento (continúa la traza del relevo del core): cada entrega abre su span CLIENT como hijo. Nunca se manda a un tercero.';
COMMENT ON COLUMN entrega.cuerpo IS 'Lo que recibe el tercero (WebhookPayload v1 o CloudEvent v2, según la suscripción), congelado al recibir el evento: un reintento envía exactamente el mismo cuerpo.';
COMMENT ON COLUMN entrega.intentos IS 'Envíos HTTP ya hechos (el que está en curso cuenta). Al llegar al máximo sin respuesta 2xx pasa a FALLIDO.';
COMMENT ON COLUMN entrega.proximo_intento IS 'Cuándo se puede tomar. Mientras un proceso la envía, el fin de su arrendamiento.';
COMMENT ON COLUMN entrega.ultimo_error IS 'Código corto del último fallo (TIMEOUT, ECONNREFUSED, HTTP_500...). Nunca un mensaje con URL o cuerpo.';
COMMENT ON COLUMN auditoria.actor IS 'sub de quien actuó; NULL si fue un proceso interno (baja automática, importación).';
COMMENT ON COLUMN auditoria.host_destino IS 'Solo el host (y puerto) de la URL: la ruta y la query pueden llevar un token del tercero.';
COMMENT ON COLUMN auditoria.motivo IS 'Código corto: FALLIDAS_SEGUIDAS en una baja automática, IMPORTADA_INACTIVA al importar una dada de baja.';
COMMENT ON COLUMN auditoria.id_peticion IS 'X-Request-Id de la petición, para cruzar con los logs.';

COMMIT;
