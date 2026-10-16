# Quinde · Notifier

Suscripciones a webhooks y entrega firmada de los eventos del sistema de vuelos Quinde (Reto 2,
fase 5a). Saca del core ([backend_vuelos](https://github.com/chuchobck/backend_vuelos)) lo que
hacía en un solo proceso: guardar las suscripciones, repartir cada evento a las que lo escuchan y
entregarlo firmado con reintentos. El core le publica sus eventos; los terceros no notan el
cambio (misma API, mismo cuerpo, misma firma).

- **Suscripciones** (contrato GDS Flight Core API 1.5.0.0, idénticas al core):
  `GET`/`POST /flights/v1/webhooks` y `DELETE /flights/v1/webhooks/{id}`, scope `flights:webhooks`.
- **Eventos** (solo el core): `POST /internal/v1/events`, scope `events:publish` con un token de
  cliente OAuth. Idempotente por `eventId`. Contrato versionado en
  [`docs/EVENTOS.md`](docs/EVENTOS.md), [`contracts/events/`](contracts/events/) y
  [`contracts/asyncapi.yaml`](contracts/asyncapi.yaml).
- **Entrega**: un proceso cada 10 s, seguro con varias instancias; 5 intentos (1, 5, 30 y 120
  minutos); `X-Webhook-Signature: sha256=` HMAC-SHA256 de `"timestamp.cuerpo"`.
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
      token cliente events:publish            por cada suscripción activa del ownerId que escucha el tipo
                                                   │
                     EntregaWebhooks (cada 10 s, FOR UPDATE SKIP LOCKED, HTTP fuera de la transacción)
                                                   ▼
                     POST <url del tercero>  X-Webhook-Event, X-Webhook-Id, X-Webhook-Timestamp,
                                             X-Webhook-Signature: sha256=HMAC(secreto, "ts.cuerpo")
```

## Empezar en local

Requisitos: Node 22 (`.nvmrc`), Docker (o un PostgreSQL propio) e identity_vuelos corriendo (o
cualquier emisor RS256 con JWKS).

```bash
npm ci
cp .env.example .env                    # completa WEBHOOK_SECRET_KEY (la del core si vas a migrar)
docker compose up -d                    # PostgreSQL 18 en el puerto 5434
./db/reset.sh                           # esquema notificaciones
npm run start:dev                       # http://localhost:3002
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
| `npm run eventos:breaking` | Compara `contracts/events` con `origin/main` y falla ante un cambio incompatible |
| `npm run suscripciones:importar -- <archivo>` | Importa las suscripciones exportadas por el core (idempotente) |
| `npm run openapi:export` | Regenera `contracts/notifier-openapi.json` |
| `./db/reset.sh` | Borra y recrea el esquema `notificaciones` (nunca la base) |

## Estructura

```text
src/
  modules/
    suscripcion/     /flights/v1/webhooks y la importación de las del core
    evento/          /internal/v1/events; contrato/: esquemas versionados y compatibilidad
    entrega/         el proceso de entrega y el HTTP (SSRF al conectar, 5 s, sin redirecciones)
    compartido/      cifrado del secreto, firma, SSRF y los 12 tipos de evento
    auditoria/       altas y bajas de suscripciones (sin secretos ni URL)
    auth/            verificador de tokens por JWKS (el de la fase 4b del core) y scopes
    salud/           /health y /health/ready
  common/            contexto y X-Request-Id, errores, logs JSON, límites, guards
  config/            entorno validado, seguridad HTTP, Swagger
  cli/               suscripciones:importar, eventos:breaking, openapi:export
contracts/           events/<tipo>.v1.json, asyncapi.yaml, notifier-openapi.json
db/                  esquema_notificaciones.sql, reset.sh
test/                e2e (identidad y receptor falsos, ataques, concurrencia, escaneo...)
```
