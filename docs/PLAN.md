# Plan — Quinde · Notifier

Reto 2 de Integración de Sistemas (PUCE). Fase 5a: sacar del core (backend_vuelos) la entrega de
webhooks y convertirla en un servicio propio, con eventos versionados. En la fase 5b el core deja
de entregar: guarda cada evento en su propia bandeja y lo publica aquí.

## Avance

| Fase | Estado | Verificación |
| --- | --- | --- |
| 5a. Notifier | Hecha (2026-10-16), en `feat/r2-notifier` | `lint`, `format:check` y `build` en cada commit. `npm test`: 254 pruebas en 10 suites contra PostgreSQL 16 local y 18.6 en CI, en verde varias veces seguidas sobre el código final. `npm run test:mutaciones`: 33 de 33 mutaciones detectadas. `npm run eventos:breaking` contra `origin/main`: los 12 esquemas como archivos nuevos (compatible). AsyncAPI validado con `@asyncapi/cli` 6.2.1 (y un `$ref` roto lo hace fallar). Verificación real con identity_vuelos (con el parche local de `events:publish`, ver Hallazgos) y un receptor local: 201 al suscribir, 403 al publicar con el token de la persona, 202 al publicar con el del core, 200 al repetirlo, el receptor recibió el POST y la firma recalculada con `openssl` coincidió; con identity caída y el notifier recién arrancado, 503 `AUTH_UNAVAILABLE` con `Retry-After: 10`, y al volver, 202. Salidas en el reporte del pull request |
| 5b. Core publica aquí | Pendiente (repo del core) | — |

## Qué se copió y qué cambió

| De dónde | Qué | Cómo quedó |
| --- | --- | --- |
| identity_vuelos | Proyecto base: Nest 10, TS estricto, Prisma 7 con `adapter-pg`, logs JSON, X-Request-Id, ProblemDetails, entorno validado, helmet, CORS, límites con `Reloj`, `/health`, Dockerfile, CI, `mutaciones.mjs`, `transformar-jose.js` | Igual, sin lo de OAuth/argon2 |
| core (fase 4b) | `ClavesJwks`, `VerificadorJwks`, `JwtAuthGuard`, `ScopesGuard`, la identidad falsa de pruebas | Igual; `ScopesGuard` suma `@SoloClientesOAuth()` y `SCOPES` suma `events:publish` |
| core (fase 10) | `CifradoSecreto`, `destino-permitido`, `ClienteWebhookHttp`, `firmar`, el DTO, las reglas y la SQL de `EntregaWebhooks` y `EntregaRepository`, el receptor falso | Igual, sobre las tablas de este esquema. Las esperas son 1, 5, 30 y 120 (la de 6 h del core nunca se usaba) |
| nuevo | `POST /internal/v1/events`, `contracts/events/`, `eventos:breaking`, AsyncAPI, importador, auditoría propia | — |

## Decisiones

Las marcadas con **(sin consultar)** se tomaron durante la fase sin poder preguntar.

| Tema | Decisión | Por qué |
| --- | --- | --- |
| `events:publish` en identity | Este servicio lo exige (como pide la fase) aunque identity todavía no lo emite. La verificación real usó una copia local de identity con un parche de dos líneas, nunca subida (decidido con el dueño del repo) | No se toca identity desde aquí; el cambio de identity va en su propio PR (Pendientes) |
| Token de persona que trae `events:publish` | 403 igual: publicar exige además un token de cliente OAuth (con `client_id`) **(sin consultar)** | Defensa en profundidad: si identity llegara a darle ese scope a un rol, una persona igual no podría publicar |
| `aud` | El mismo `quinde-vuelos-api` que el core (`JWT_AUDIENCE` obligatoria) **(sin consultar)** | identity emite un solo `aud`; así el token de una persona sirve igual en `/flights/v1/webhooks` del core y aquí. Lo que separa a la persona del publicador es el scope y el `client_id` |
| `realm` de WWW-Authenticate | `quinde-vuelos-api`, el del core **(sin consultar)** | Mismos tokens; `/flights/v1/webhooks` responde igual que en el core |
| Tablas | `suscripcion`, `suscripcion_evento`, `evento`, `entrega` (las pedidas) y `auditoria`. Los 12 tipos como CHECK (`fn_es_tipo_evento`), no como tabla catálogo **(sin consultar)** | La lista es cerrada por el contrato; una tabla sumaría un join en cada reparto sin dar flexibilidad real (agregar un tipo exige su esquema y su código igual) |
| Auditoría | Tabla propia de solo inserción, escrita por el service en la misma transacción, con el host del destino y no la URL **(sin consultar)** | El core usaba un trigger genérico que copia la fila (con la URL); la URL puede llevar un token del tercero |
| Repetición con otro contenido | 409 (se compara la SHA-256 del sobre canónico, sin importar el orden de las claves) **(sin consultar)** | Un `eventId` identifica un hecho; dos contenidos distintos son un error del publicador, no algo para tapar con un 200 |
| `schemaVersion` | `mayor.menor`; un archivo por mayor; los menores aceptados en `schemaVersion.enum`. Mayor sin archivo o menor no listado: 422 | Un menor nuevo (campos opcionales) no exige otro archivo; un mayor sí |
| `additionalProperties: false` en el sobre y en `data` **(sin consultar)** | Un campo nuevo entra primero al esquema (compatible) y después lo publica el core | Así nada que el esquema no declare (un dato personal, por descuido) llega a un tercero |
| Volver opcional un campo obligatorio | Incompatible (pide v2) **(sin consultar)** | No estaba en la lista de la fase, pero el tercero contaba con ese campo |
| `occurredAt` | Se exige UTC con `Z`; el `WebhookPayload` lo lleva normalizado con milisegundos (`toISOString`) | Lo que pedía la fase y lo que mandaba el core (`to_char(... 'MS"Z"')`) |
| Cuerpo congelado | `entrega.cuerpo` jsonb, armado al recibir el evento; se firma `JSON.stringify` de ese valor | Como el core: jsonb devuelve siempre el mismo orden, así cada reintento firma y envía los mismos bytes |
| Límite de la API interna | `POST /internal/v1/events` no cuenta en el límite global por IP; tiene el suyo, `EVENTS_RATE_LIMIT_MAX` (1200 por minuto e IP) **(sin consultar)** | El core publica en ráfagas desde pocas IP (un vuelo cancelado = un evento por reserva); 100 por minuto lo cortaría |
| Rutas | `/flights/v1/webhooks` (la del contrato), `/internal/v1/events` y `/health` en la raíz **(sin consultar)** | Las dos primeras las fijó la fase; la salud sin versión, como la sondea un orquestador |
| Archivo de migración | JSON Lines con los campos pedidos más `fechaCreacion` opcional; un campo desconocido rechaza la línea **(sin consultar)** | `fechaCreacion` conserva el orden de `GET`; rechazar campos de más evita que un exportador mande, por ejemplo, el secreto en claro |
| Importador | No exige el máximo de 10 ni vuelve a resolver el DNS **(sin consultar)** | El core ya lo validó; la SSRF se vuelve a aplicar en cada entrega |
| AsyncAPI en CI | `npx @asyncapi/cli@6.2.1 validate`, sin agregarlo a `package.json` **(sin consultar)** | Es grande y solo hace falta en CI |
| Dependencias nuevas | `jose` 6 (verificar RS256 por JWKS; la de identity y el core), `ajv` 8 y `ajv-formats` 3 (validar el sobre contra los esquemas versionados; las del core) | Un validador a mano duplicaría el contrato |

## Commits de la fase 5a

1. `chore: crear el proyecto base con NestJS 10, Prisma 7 y el esquema notificaciones`
2. `feat(comun): agregar contexto, ProblemDetails, logs JSON, entorno, límites, salud y tokens por JWKS`
3. `feat(suscripciones): registrar, listar y dar de baja suscripciones en /flights/v1/webhooks`
4. `feat(eventos): agregar el contrato versionado de los 12 eventos, eventos:breaking y AsyncAPI`
5. `feat(eventos): recibir eventos en POST /internal/v1/events y repartirlos a las suscripciones`
6. `feat(entrega): enviar las entregas pendientes firmadas con HMAC y reintentos`
7. `feat(migracion): importar las suscripciones del core con npm run suscripciones:importar`
8. `refactor(migracion): exportar importarArchivo para probar la salida del importador`
9. `fix(migracion): no rechazar la suscripción que otra importación simultánea acaba de confirmar`
10. `feat(eventos): exigir que el $id de un esquema termine en el nombre de su archivo`
11. `test: probar publicación, tokens, entrega, suscripciones, importación y el escaneo`
12. `test: romper a propósito lo que cubre cada prueba (npm run test:mutaciones)`
13. `feat(openapi): exportar contracts/notifier-openapi.json y probar que esté al día`
14. `build(despliegue): agregar Dockerfile sin privilegios, CI con PostgreSQL y docs/DEPLOY.md`
15. `docs: agregar CLAUDE.md, README, CHANGELOG 0.1.0 y el plan con el cierre de la fase 5a`
16. `fix(suscripciones): rechazar la URL repetida antes de insertar para que PostgreSQL no la registre`

## Qué no se pudo verificar

- **La imagen de Docker en local**: Docker Hub respondió 429 al bajar `node:22-bookworm-slim`, y
  dentro de un contenedor de este entorno npm no confía en la CA del proxy. La construye el job
  `imagen` del CI, que pasó (uid 1000 y los 12 esquemas adentro). No se corrió el contenedor contra
  una base.
- **actionlint**: no se pudo instalar aquí; el YAML del workflow parsea y lo ejercita el CI.
- **PostgreSQL 18 en local**: las pruebas locales corrieron sobre PostgreSQL 16; en CI pasan sobre 18.6.
- **identity sin parche**: con el identity de `main`, `cliente:crear --scopes events:publish` falla
  (el scope no existe). La verificación real usó la copia parcheada.

## Hallazgos

| Tema | Qué pasó | Qué implica |
| --- | --- | --- |
| identity no emite `events:publish` | Su `SCOPES`, `cliente:crear`, `/oauth2/token` y el CHECK `ck_cliente_oauth_scopes` solo admiten los 6 `flights:*` | Pendiente en identity (abajo). El parche usado en la verificación: agregar `'events:publish'` a `SCOPES` y al CHECK (cardinalidad 1 a 7) |
| Repetición `{1,300}` en una expresión regular | PostgreSQL no admite más de 255 en `{m,n}`: el CHECK del host de la auditoría daba `2201B` en cada alta (400 "invalid format") | Se cambió por `length(...) <= 300`. Lo encontró la verificación con `curl` antes de las pruebas |
| Importaciones simultáneas | En READ COMMITTED una importación podía no ver la fila de la otra al buscar el id y verla un instante después al buscar la URL: la rechazaba como URL repetida | El choque de URL ahora excluye el mismo id (commit 9). Lo encontró la prueba de importaciones simultáneas |
| v2 copiada de la v1 | Conserva el `$id` y Ajv rechaza el segundo esquema con el mismo id; el servicio no arrancaba con un mensaje confuso | Regla de forma: el `$id` termina en el nombre del archivo (commit 10). Lo encontró la prueba de convivencia v1/v2 |
| `SKIP LOCKED` y las pruebas de concurrencia | Sin `SKIP LOCKED` (con `FOR UPDATE` solo) las dos pruebas de concurrencia seguían en verde: Postgres reevalúa la fila bloqueada y no duplica, solo espera | Nueva prueba: una fila tomada por otro proceso no frena la corrida (3 s). Sin `FOR UPDATE` del todo, la de 4 reclamos a la vez tampoco falló aquí (no se cruzaron); la nueva lo nota igual |
| `ConfigService` y `process.env` | `new ConfigService({ X })` devuelve el `process.env.X` si existe, no el del objeto | Solo afectó a un dato de prueba armado a mano; el importador usa el entorno a propósito |
| PostgreSQL registra la URL de un 409 | El log del servicio PostgreSQL del CI mostró el `DETAIL` de la violación de `uq_suscripcion_propietario_url`: `Key (id_propietario, url)=(…, http://…?token=…)`. Es el log de la base, fuera de la app, pero deja la URL (y su token) donde nadie la busca | Con el candado del dueño tomado, la URL repetida se pregunta antes de insertar y responde el mismo 409 sin llegar al índice (commit 16). El índice sigue como última barrera. El core tiene el mismo comportamiento |
| El Logger de Nest es global | Una app creada en una prueba sin `logs` apagaba los logs de las pruebas siguientes del mismo archivo | Las apps de una misma prueba comparten el arreglo de logs |

## Pendientes

- **identity_vuelos**: agregar `events:publish` a `SCOPES` y al CHECK `ck_cliente_oauth_scopes`, y
  crear el cliente del core (`npm run cliente:crear -- --nombre "Core de vuelos" --scopes
  "events:publish" --client-id core-vuelos`). Sin eso, el core no puede publicar.
- **Core, fase 5b**: ver la sección siguiente.
- Purga de eventos y entregas viejas ya resueltas (hoy no se borra nada).
- Un endpoint para que el dueño vea el estado de sus entregas (no está en el contrato).
- Límite de peticiones compartido entre instancias (hoy en memoria por instancia, como el core).

## Lo que necesita el core en la fase 5b

**Publicar**: `POST {NOTIFIER_URL}/internal/v1/events`, `Content-Type: application/json`,
`Authorization: Bearer <token>`. Cuerpo (el sobre, `docs/EVENTOS.md`):

```json
{
  "eventId": "<uuid, el mismo en cada reintento>",
  "eventType": "booking.confirmed",
  "schemaVersion": "1.0",
  "occurredAt": "2026-10-16T14:30:00.000Z",
  "ownerId": "<id_propietario del recurso: el sub de quien lo creó>",
  "data": { "bookingId": "<uuid>", "pnr": "Q7K2MX", "status": "CONFIRMED" }
}
```

Respuestas: `202` guardado (después del commit), `200` ya estaba (idempotente: reintentar es
seguro), `400`/`409`/`415`/`422` error del publicador (no reintentar, alertar), `401` token
inválido (pedir otro), `429`/`503`/`5xx` reintentar con espera (`Retry-After`).

**Token**: cliente OAuth de identity con `events:publish` (Pendientes de identity).
`POST {JWT_ISSUER}/oauth2/token` con `grant_type=client_credentials&scope=events:publish` y
`Authorization: Basic base64(client_id:client_secret)`; dura 15 minutos y no tiene refresh: se pide
otro al vencer.

**`data` por tipo** (los mismos campos que armaba el `INSERT ... SELECT` de la fase 10):

| Tipo | `data` |
| --- | --- |
| `booking.confirmed`, `.failed`, `.changed`, `.baggage_added`, `.ticket_issuing`, `.ticket_issued`, `.ticket_failed`, `.checked_in` | `bookingId` (uuid), `pnr` (`^[A-Z0-9]{6}$`), `status` (`BookingDetail.status` en el momento del evento) |
| `booking.cancelled` | lo mismo y `refundAmount` opcional (texto, `"35.00"`) |
| `hold.expired` | `holdId` (uuid), `status: "EXPIRED"` |
| `flight.schedule_changed`, `flight.cancelled` | `bookingId`, `pnr`, `status`, `flightNumber` (`EQ1234`), `segmentId` (uuid); un evento por reserva viva, cada uno con su `eventId` |

Ningún campo de más (`additionalProperties: false`). El core sigue decidiendo QUÉ eventos emite y
a QUIÉN pertenecen (`ownerId`); el notifier decide a qué suscripciones van.

**Migración de suscripciones**: el exportador del core escribe JSON Lines con `id`,
`idPropietario`, `url`, `secretoCifrado` (el `webhook_cabecera.secreto` tal cual, `v1.…`),
`eventos`, `activo` y, opcional, `fechaCreacion` (`docs/MIGRACION.md`). Aquí se importa con
`npm run suscripciones:importar -- archivo.jsonl`.

**Variables**: en el notifier, `WEBHOOK_SECRET_KEY` **igual a la del core**, `JWT_ISSUER` y
`JWT_AUDIENCE` las de identity (`docs/DEPLOY.md`). En el core (nombres sugeridos): la URL del
notifier, el `client_id` y el `client_secret` del cliente `core-vuelos`, y al cortar,
`WEBHOOK_DELIVERY_JOB_ENABLED=false` (su entrega se apaga en el mismo despliegue en que
`/flights/v1/webhooks` pasa al notifier; orden en `docs/MIGRACION.md`).
