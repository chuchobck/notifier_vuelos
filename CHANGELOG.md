# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones con
[SemVer](https://semver.org/lang/es/).

## [0.2.0] - 2026-10-27

Fase N2 del contrato de Vuelos v2 (RDA2): las suscripciones y entregas a Booking pasan a
CloudEvents 1.0. Fase 7e: el notifier adopta el estándar de observabilidad de gateway_vuelos.

### Agregado

- `GET`/`POST /api/v2/vuelos/webhooks` y `DELETE /api/v2/vuelos/webhooks/{id}` con las mismas
  reglas de v1 y los 15 `VuelosEventName`. Cada suscripción guarda su formato: las de v1 siguen
  recibiendo el `WebhookPayload` byte a byte; las de v2, un CloudEvent 1.0 estructurado
  (`application/cloudevents+json`, `type` `ec.edu.epn.booking.vuelos.<evento>`, `source`
  `/aerolineas/<AIRLINE_CODE>/vuelos`, `subject`, `correlationid`) firmado con HMAC-SHA256 del
  cuerpo, con reintentos a 1, 5, 30, 120 y 360 minutos.
- `GET /api/v2/vuelos/eventos`: el feed de CloudEvents del dueño del token (scope `flights:read`),
  por cursor `after` y `limit`.
- `ProblemDetails` v2 (`instance`, `correlation_id`, `timestamp`, enum de `code` de v2) en `/api/v2`.
- `X-Correlation-Id` en cada respuesta y log; el sobre acepta `correlationId` (esquemas 1.1), que
  llega al CloudEvent y a la cabecera de cada entrega (v1 y v2).
- Esquemas 1.1 con la data ampliada del contrato v2 (todo opcional) y los tipos `hold.created`,
  `booking.seat_changed` y `flight.status_changed`. AsyncAPI 1.1.0.
- Observabilidad: trazas OpenTelemetry (continúan el `traceparent` del relevo del core; un span
  CLIENT por intento de entrega, sin mandar `traceparent` al tercero), `X-Trace-Id`, logs con
  `traceId` y `spanId`, métricas en `METRICS_PORT` (las comunes y `notifier_deliveries_total`,
  `notifier_delivery_duration_seconds`, `notifier_events_received_total`,
  `notifier_deliveries_pending` y `notifier_deliveries_oldest_pending_seconds`).
- `db/migraciones/001_cloudevents.sql`, `./db/migrar.sh` y su comprobación en CI.
- Variables nuevas, todas opcionales: `AIRLINE_CODE`, `OTEL_SERVICE_NAME`,
  `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER_ARG`, `TRACE_TRUST_INCOMING` y `METRICS_PORT`.

### Cambiado

- La línea de acceso y el log de errores escriben la plantilla de la ruta, sin IP ni usuario.
- Las entregas v1 suman la cabecera `X-Correlation-Id` (fuera del cuerpo y de la firma).

## [0.1.0] - 2026-10-16

Primera versión (Reto 2, fase 5a): la entrega de webhooks sale del core a un servicio propio.

### Agregado

- Suscripciones en `GET`/`POST /flights/v1/webhooks` y `DELETE /flights/v1/webhooks/{id}`,
  idénticas al core y al contrato GDS Flight Core API 1.5.0.0: scope `flights:webhooks`, a lo sumo
  10 activas por usuario, 409 con la URL repetida, 10 altas por minuto e IP, 404 si es ajena o
  inactiva, secreto cifrado (AES-256-GCM, el formato `v1.` del core) y enmascarado en las
  respuestas, y protección SSRF al registrar y al enviar.
- `POST /internal/v1/events`: el core publica sus eventos con un token de cliente OAuth con
  `events:publish` (verificado por el JWKS de identity_vuelos). Idempotente por `eventId` (202,
  200, 409 con otro contenido); 422 con un tipo o una versión desconocidos. En una transacción
  guarda el evento y crea una entrega por cada suscripción activa del dueño que escucha el tipo.
- Contrato de eventos versionado: un JSON Schema por tipo y versión en `contracts/events/`,
  `docs/EVENTOS.md` con la regla de compatibilidad, `npm run eventos:breaking` (corre en los pull
  requests) y `contracts/asyncapi.yaml` (validado en CI).
- Entrega firmada con reintentos, con las reglas del core: cada 10 s, `FOR UPDATE SKIP LOCKED` y
  arrendamiento de 2 minutos, 5 intentos (1, 5, 30 y 120 minutos), baja automática tras 10
  fallidas seguidas, `X-Webhook-*` y firma `sha256=` HMAC-SHA256 de `"timestamp.cuerpo"`.
  `NOTIFIER_DELIVERY_JOB_ENABLED` la apaga.
- `npm run suscripciones:importar`: importa las suscripciones que exporte el core (JSON Lines,
  `docs/MIGRACION.md`), idempotente y sin imprimir secretos ni URL.
- Operación: `/health` y `/health/ready`, X-Request-Id, logs JSON, helmet, CORS por lista, límites
  de peticiones con un reloj inyectable, auditoría de altas y bajas (sin secretos ni URL), Swagger
  con `contracts/notifier-openapi.json` versionado, Dockerfile sin privilegios y CI con PostgreSQL.
- 254 pruebas e2e (10 suites) y 33 mutaciones (`npm run test:mutaciones`), todas detectadas.
