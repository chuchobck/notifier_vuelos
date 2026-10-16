# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones con
[SemVer](https://semver.org/lang/es/).

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
