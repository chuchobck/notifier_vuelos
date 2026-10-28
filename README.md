# Quinde · Notifier

Suscripciones a webhooks y entrega firmada de los eventos del sistema de vuelos Quinde (Reto 2,
fase 5a). Saca del core ([backend_vuelos](https://github.com/chuchobck/backend_vuelos)) lo que
hacía en un solo proceso: guardar las suscripciones, repartir cada evento a las que lo escuchan y
entregarlo firmado con reintentos. El core le publica sus eventos; los terceros no notan el
cambio (misma API, mismo cuerpo, misma firma).

- **Suscripciones** (contrato GDS Flight Core API 1.5.0.0, idénticas al core):
  `GET`/`POST /flights/v1/webhooks` y `DELETE /flights/v1/webhooks/{id}`, scope `flights:webhooks`.
- **Contrato de Vuelos v2** (RDA2, el de Booking Prototipo):
  `GET`/`POST /api/v2/vuelos/webhooks` y `DELETE /api/v2/vuelos/webhooks/{id}` (los 15
  `VuelosEventName`, entrega en **CloudEvents 1.0**) y el feed `GET /api/v2/vuelos/eventos`
  (scope `flights:read`), con el `ProblemDetails` v2. Cada suscripción recibe el formato de la API
  por la que se creó: las de v1 siguen recibiendo el `WebhookPayload` de siempre.
- **Eventos** (solo el core): `POST /internal/v1/events`, scope `events:publish` con un token de
  cliente OAuth. Idempotente por `eventId`. Contrato versionado en
  [`docs/EVENTOS.md`](docs/EVENTOS.md), [`contracts/events/`](contracts/events/) y
  [`contracts/asyncapi.yaml`](contracts/asyncapi.yaml).
- **Entrega**: un proceso cada 10 s, seguro con varias instancias. v1: 5 intentos (1, 5, 30 y 120
  minutos), `X-Webhook-Signature: sha256=` HMAC-SHA256 de `"timestamp.cuerpo"`. v2:
  `application/cloudevents+json`, 6 intentos (1, 5, 30, 120 y 360 minutos), HMAC-SHA256 del cuerpo.
  Las dos con `X-Correlation-Id` y nunca con `traceparent`.
- **Correlación y observabilidad** (estándar de gateway_vuelos): `X-Correlation-Id` y `X-Trace-Id`
  en cada respuesta, logs JSON con `requestId`, `correlationId`, `traceId` y `spanId`, trazas
  OpenTelemetry que continúan la del relevo del core hasta cada entrega, y métricas Prometheus en
  `METRICS_PORT` (9468 en local).
- **Salud**: `GET /health` y `/health/ready`. **Documentación**: Swagger en `/api/docs`; el
  contrato en [`contracts/notifier-openapi.json`](contracts/notifier-openapi.json).

NestJS 10, TypeScript estricto, Prisma 7 sobre PostgreSQL (esquema `notificaciones`), `jose` para
verificar los tokens RS256 de [identity_vuelos](https://github.com/chuchobck/identity_vuelos) y
Ajv para los esquemas de eventos. Reglas en [`CLAUDE.md`](CLAUDE.md); plan y decisiones en
[`docs/PLAN.md`](docs/PLAN.md); despliegue en [`docs/DEPLOY.md`](docs/DEPLOY.md); migración de las
suscripciones del core en [`docs/MIGRACION.md`](docs/MIGRACION.md).

## Cómo viaja un evento

```text
core ──POST /internal/v1/events──▶ notifier ──(una transacción)──▶ evento + una entrega PENDIENTE
      token cliente events:publish            por cada suscripción activa del ownerId que escucha el tipo,
      traceparent, X-Correlation-Id           con el cuerpo de su formato (Traductores: v1 o CloudEvent)
                                                   │
                     EntregaWebhooks (cada 10 s, FOR UPDATE SKIP LOCKED, HTTP fuera de la transacción,
                                      un span CLIENT por intento, hijo de la traza del evento)
                                                   ▼
        v1: POST <url>  X-Webhook-Event, X-Webhook-Id, X-Webhook-Timestamp, X-Correlation-Id,
                        X-Webhook-Signature: sha256=HMAC(secreto, "ts.cuerpo")
        v2: POST <url>  Content-Type: application/cloudevents+json, X-Correlation-Id,
                        X-Webhook-Signature: sha256=HMAC(secreto, cuerpo)
        Booking: GET /api/v2/vuelos/eventos?after=<id>  (el respaldo: los mismos CloudEvents)
```

## Empezar en local

Requisitos: Node 22 (`.nvmrc`), Docker (o un PostgreSQL propio) e identity_vuelos corriendo (o
cualquier emisor RS256 con JWKS).

```bash
npm ci
cp .env.example .env                    # completa WEBHOOK_SECRET_KEY (la del core si vas a migrar)
docker compose up -d                    # PostgreSQL 18 en el puerto 5434
./db/reset.sh                           # esquema notificaciones
./db/migrar.sh                          # si la base ya existía (fase 5a): la pone al día
npm run start:dev                       # http://localhost:3002, métricas en :9468/metrics
```

Un recorrido con `curl` (tokens de identity_vuelos):

```bash
N=http://localhost:3002
curl -s -X POST $N/flights/v1/webhooks -H "Authorization: Bearer $TOKEN_PERSONA" \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:4010/hook","events":["booking.confirmed"],"secret":"un-secreto-compartido-largo"}'
curl -s -X POST $N/internal/v1/events -H "Authorization: Bearer $TOKEN_CORE" \
  -H 'Content-Type: application/json' -d '{
    "eventId": "5f8d2c1e-7a3b-4e9d-8c6f-000000000000", "eventType": "booking.confirmed",
    "schemaVersion": "1.0", "occurredAt": "2026-10-16T14:30:00Z", "ownerId": "<sub de la persona>",
    "data": { "bookingId": "3f0c6a9e-2b1d-4c8e-9a7f-5d4e3c2b1a09", "pnr": "Q7K2MX", "status": "CONFIRMED" }
  }'                                    # 202; repetido, 200 (docs/EVENTOS.md)
```

## Scripts

| Script | Qué hace |
| --- | --- |
| `npm run start:dev` | El servicio con recarga |
| `npm run build` / `npm run start:prod` | Compilar y correr `dist/` |
| `npm run lint`, `format:check`, `typecheck` | Calidad (lo mismo que CI) |
| `npm test` | Suite e2e contra PostgreSQL (la base del `.env` o `DATABASE_URL`) |
| `npm run test:mutaciones` | Rompe el código a propósito (33 mutaciones) y exige que alguna prueba falle |
| `./db/migrar.sh` | Aplica `db/migraciones/*.sql` (idempotentes) a una base que ya existe |
| `npm run eventos:breaking` | Compara `contracts/events` con `origin/main` y falla ante un cambio incompatible |
| `npm run suscripciones:importar -- <archivo>` | Importa las suscripciones exportadas por el core (idempotente) |
| `npm run openapi:export` | Regenera `contracts/notifier-openapi.json` |
| `./db/reset.sh` | Borra y recrea el esquema `notificaciones` (nunca la base) |

## Estructura

```text
src/
  modules/
    suscripcion/     /flights/v1/webhooks, v2/ (/api/v2/vuelos/webhooks) y la importación del core
    evento/          /internal/v1/events; contrato/: esquemas versionados y compatibilidad;
                     traductores/: WebhookPayload v1 y CloudEvent v2; v2/: el feed /api/v2/vuelos/eventos
    entrega/         el proceso de entrega y el HTTP (SSRF al conectar, 5 s, sin redirecciones)
    compartido/      cifrado del secreto, firma, SSRF y los 12 tipos de evento
    auditoria/       altas y bajas de suscripciones (sin secretos ni URL)
    auth/            verificador de tokens por JWKS (el de la fase 4b del core) y scopes
    salud/           /health y /health/ready
  observabilidad/    trazas (OpenTelemetry) y métricas (prom-client): el estándar del gateway
  common/            contexto, X-Request-Id y X-Correlation-Id, errores (ProblemDetails v1 y v2), logs JSON, límites, guards
  config/            entorno validado, seguridad HTTP, Swagger
  cli/               suscripciones:importar, eventos:breaking, openapi:export
contracts/           events/<tipo>.v1.json, asyncapi.yaml, notifier-openapi.json
db/                  esquema_notificaciones.sql, reset.sh, migrar.sh y migraciones/
test/                e2e (identidad, receptor y recolector OTLP falsos, contrato v2, ataques, concurrencia, escaneo...)
```
