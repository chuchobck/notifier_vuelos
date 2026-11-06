# Despliegue — Quinde · Notifier

Guía para levantar el servicio fuera de la máquina de desarrollo. No hay `render.yaml` ni la
configuración de una nube: lo que sigue vale para cualquier lugar que corra un contenedor y tenga
un PostgreSQL.

## Qué se despliega

- **Una imagen de Docker** (`Dockerfile`, multi-etapa). Corre como el usuario `node` (uid 1000),
  sin privilegios y sin poder escribir en su propio código. Lleva `dist/` y los esquemas de
  `contracts/events` (el servicio los compila al arrancar y no levanta sin ellos). No lleva
  claves ni credenciales: todo llega por variables de entorno.
- **Un PostgreSQL** con el esquema `notificaciones` (`db/esquema_notificaciones.sql`), en una base
  propia (`notifier_db`).
- **Rutas de salud**, públicas y sin límite de peticiones:
  - `GET /health`: el proceso responde (no mira la base). Es la del `HEALTHCHECK` de la imagen.
  - `GET /health/ready`: 200 solo si la base contesta (503 si no). Para sacar la instancia del
    balanceador mientras la base no responde.

```bash
docker build -t quinde-notifier .
docker run --rm -p 3002:3002 --env-file .env.produccion quinde-notifier
```

Se pueden correr **varias instancias a la vez**: cada entrega se toma con `FOR UPDATE SKIP LOCKED`
y un arrendamiento de 2 minutos, así que dos procesos nunca envían la misma, y si uno muere a mitad
de un envío la entrega vuelve sola al vencer el arrendamiento. El límite de peticiones es en memoria
por instancia (como en el core y en identity).

## Variables de entorno

El servicio valida el entorno al arrancar: si una obligatoria falta o tiene un formato inválido, no
levanta y el error nombra la variable (nunca muestra su valor). Una variable vacía (`JWKS_URL=`)
cuenta como no definida.

| Variable | Obligatoria | Ejemplo | Qué pasa si falta |
| --- | --- | --- | --- |
| `DATABASE_URL` | Sí | `postgresql://notifier:***@host:5432/notifier_db?schema=notificaciones&sslmode=require` | No arranca. `?schema=` elige el esquema (por defecto `notificaciones`) |
| `NODE_ENV` | Sí | `production` | No arranca. En `production`: logs sin `debug`, `JWT_ISSUER` y `JWKS_URL` https, y las URL de webhook solo https y nunca hacia loopback |
| `PORT` | Sí | `3002` | No arranca |
| `JWT_ISSUER` | Sí | `https://identity.quinde.example` | No arranca. El `JWT_ISSUER` de identity_vuelos: un origen sin ruta ni barra final, que se compara texto a texto con el `iss` de cada token. https en producción |
| `JWT_AUDIENCE` | Sí | `quinde-vuelos-api` | No arranca. El `aud` que emite identity_vuelos (uno solo para todo el sistema) |
| `JWKS_URL` | No | `http://identity.interna:3001/.well-known/jwks.json` | `{JWT_ISSUER}/.well-known/jwks.json`. Sirve si el JWKS se lee por una red interna. https en producción |
| `WEBHOOK_SECRET_KEY` | Sí | 48 bytes al azar en base64url | No arranca (y con menos de 32 caracteres tampoco). Cifra los secretos de las suscripciones. **Tiene que ser la misma del core** para migrar sus suscripciones (docs/MIGRACION.md). Cambiarla deja ilegibles los secretos guardados: sus entregas fallan con `SECRET_UNREADABLE` |
| `CORS_ORIGINS` | No | `https://quinde.example.com,http://localhost:5173` | Ningún origen de navegador puede llamar. Nunca `*` (no arranca) |
| `TRUST_PROXY` | No | `1` | Se usa la IP del socket: detrás de un balanceador, todos los clientes comparten el límite por IP y la auditoría guarda la IP del balanceador. `true` no se acepta |
| `RATE_LIMIT_MAX` | No | `100` | 100 peticiones por IP y por ventana en la API pública |
| `RATE_LIMIT_WINDOW_SECONDS` | No | `60` | 60 segundos |
| `EVENTS_RATE_LIMIT_MAX` | No | `1200` | 1200 publicaciones por minuto e IP en `POST /internal/v1/events`, que no cuenta en el límite global (el core publica en ráfagas) |
| `NOTIFIER_DELIVERY_JOB_ENABLED` | No | `true` | `true`: el proceso de entrega corre. Con `false` los eventos se guardan y se reparten, pero no se envían |
| `NOTIFIER_DELIVERY_JOB_INTERVAL_SECONDS` | No | `10` | 10 segundos entre corridas (de 5 a 3600) |
| `AIRLINE_CODE` | No | `ecoairlines` | `quinde`. El código de la aerolínea en el `source` de cada CloudEvent de una suscripción v2: `/aerolineas/<AIRLINE_CODE>/vuelos` (contrato de Vuelos v2, §8). Minúsculas, dígitos y guiones (2 a 40); otro formato no arranca. Cambiarlo cambia el `source` de lo que se entregue y del feed desde ese momento (lo ya congelado en `entrega.cuerpo` no cambia) |
| `RABBITMQ_ENABLED` | No | `true` | `false`: el notifier no abre conexión con el broker y funciona exactamente como antes (los eventos llegan solo por `POST /internal/v1/events`). Con `true` consume la cola `notifier.eventos` (ver «Consumidor de RabbitMQ») |
| `RABBITMQ_URL` | Con `RABBITMQ_ENABLED=true` | `amqps://notifier:***@rabbit.interno:5671` | Con el consumidor encendido y sin ella, no arranca. `amqp://` o `amqps://`; lleva credenciales: nunca se registra ni aparece en un error |
| `RABBITMQ_PREFETCH` | No | `10` | 10 mensajes sin confirmar a la vez (de 1 a 1000) |
| `OTEL_SERVICE_NAME` | No | `quinde-notifier` | `quinde-notifier` (`service.name` de trazas y métricas; estándar de observabilidad de gateway_vuelos) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | `http://jaeger:4318` | Vacía: las trazas no se exportan (el SDK arranca igual: `traceId` en los logs y `X-Trace-Id`). Con valor, OTLP/HTTP a `{endpoint}/v1/traces` en lotes cada 2 s, con plazo de 3 s: un recolector caído nunca frena una petición ni una entrega |
| `OTEL_TRACES_SAMPLER_ARG` | No | `0.1` | 1.0 en desarrollo y 0.1 en producción (fracción de trazas raíz; una hija sigue a su padre, así que la traza del relevo del core decide) |
| `TRACE_TRUST_INCOMING` | No | `true` | `true`: continúa el `traceparent` que llega (el gateway y el relevo del core). El notifier es interno; `false` solo si quedara expuesto sin gateway |
| `METRICS_PORT` | No | `9464` | 9464 (en local, 9468: la tabla del estándar para correr los cinco servicios en una máquina). `/metrics` de Prometheus en ese puerto aparte, que el ingress no debe exponer; `0` lo apaga. Tiene que ser distinto de `PORT` |
| `DB_PORT` | No (solo `docker-compose.yml`) | `5434` | 5434 |

Generar la clave de los secretos (solo si el core todavía no tiene una; si la tiene, usar esa):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Los límites propios (10 altas de suscripción por minuto e IP, 10 suscripciones activas por
usuario, sumando v1 y v2) y las reglas de entrega están en el código, no en el entorno: v1, las del
core (5 intentos, esperas de 1, 5, 30 y 120 minutos); v2, las del contrato de Vuelos v2 (6 intentos,
esperas de 1, 5, 30, 120 y 360 minutos); en los dos, plazo de 5 s y baja tras 10 fallidas seguidas.

## Consumidor de RabbitMQ

Camino principal de los eventos (fase 4b): el gateway los deja en RabbitMQ y el notifier los
consume con la misma `PublicacionEventos` que usa `POST /internal/v1/events`, que queda de respaldo.
Con `RABBITMQ_ENABLED=false` (el valor por defecto) nada de esto corre. `/health` y `/health/ready`
no dependen del broker; el estado se ve en el log (`Estado de RabbitMQ: ...`) y en el gauge
`notifier_amqp_connected`.

El notifier **declara** esto al conectar (idempotente: sobrevive a un broker nuevo o con colas
borradas):

| Elemento | Detalle |
| --- | --- |
| Exchange `vuelos.eventos` | `topic`, durable. El gateway publica con `routingKey = eventType`, `messageId = eventId` y el sobre JSON exacto como cuerpo |
| Cola `notifier.eventos` | Durable, ligada al exchange con `#`. La que consume el notifier |
| Cola `notifier.eventos.retry` | Durable, TTL de 30 s. Al expirar, el mensaje vuelve **directo** a `notifier.eventos` (exchange por defecto), no al exchange: así no se repite en otras colas que se liguen a `vuelos.eventos` |
| Cola `notifier.eventos.dlq` | Durable, sin TTL ni consumidor. Aquí se revisa a mano |

Si el gateway declara también el exchange, que use los mismos argumentos (`topic`, durable): un
exchange declarado con otros argumentos hace fallar al segundo con `PRECONDITION_FAILED`.

El broker no garantiza orden entre eventos; el tercero ordena por `occurredAt`.

**Qué pasa con cada mensaje** (detalle en docs/EVENTOS.md): aceptado o repetido con el mismo
contenido, `ack`. Sobre inválido, tipo desconocido o `eventId` con otro contenido, a la DLQ y `ack`,
sin reintento. Error transitorio (base caída, timeout), a `notifier.eventos.retry`; al quinto
intento, a la DLQ. Si el broker no está al arrancar o se cae, el notifier sigue sirviendo y
reconecta con espera creciente (de 1 s a 30 s).

### Reencolar a mano desde la DLQ

Cada mensaje de la DLQ trae `x-estado`, `x-motivo` (nombra campos, nunca valores) y
`x-routing-key-original`; no trae `x-death` ni `x-intentos`, así que al reencolarlo empieza con los
cinco intentos completos. **Reencolar solo tiene sentido si se arregló la causa:** un `SOBRE_INVALIDO`
o un `CONFLICTO` vuelve a la DLQ igual (hay que corregir al publicador, no reencolar).
`REINTENTOS_AGOTADOS` sí es reencolable cuando la base ya responde.

1. Revisar: panel de gestión, cola `notifier.eventos.dlq` → *Get messages* (con *Nack message
   requeue true*, para no sacarlos), o `rabbitmqadmin get queue=notifier.eventos.dlq count=10 ackmode=ack_requeue_true`.
2. Mover todos a la cola principal, con el plugin Shovel (panel de gestión → cola → *Move messages*,
   con destino `notifier.eventos`), o por línea de comandos:

   ```bash
   rabbitmqctl set_parameter shovel reencolar-dlq '{
     "src-protocol": "amqp091", "src-uri": "amqp://", "src-queue": "notifier.eventos.dlq",
     "dest-protocol": "amqp091", "dest-uri": "amqp://", "dest-queue": "notifier.eventos",
     "src-delete-after": "queue-length"
   }'
   rabbitmqctl clear_parameter shovel reencolar-dlq   # al terminar
   ```

   Se manda a la **cola** (no al exchange) para que solo el notifier lo reciba otra vez. La
   publicación es idempotente por `eventId`: reencolar un evento que sí se había guardado da un
   duplicado y se descarta.
3. Un solo evento: publicar su cuerpo a mano con `POST /internal/v1/events` (el respaldo HTTP) y
   borrarlo de la DLQ.

Métricas (`/metrics`, solo en `METRICS_PORT`): `notifier_amqp_consumed_total`,
`notifier_amqp_results_total{result=accepted|duplicate|dead_lettered|retried}` y
`notifier_amqp_connected` (1/0). Una DLQ que crece se ve en `dead_lettered`; el tamaño de la cola
lo da el propio RabbitMQ.

## Base de datos

Una base `notifier_db` (en Neon, otra base del mismo proyecto; en local, el `docker-compose.yml` de
este repo en el puerto 5434). El esquema `notificaciones` no apunta a ninguna tabla del core ni de
identity: las credenciales de esta base no abren las otras.

```bash
DATABASE_URL="postgresql://...@host/notifier_db?schema=notificaciones&sslmode=require" \
  CONFIRMAR_RESET=si ./db/reset.sh          # solo la primera vez: crea el esquema
DATABASE_URL="..." ./db/migrar.sh           # en cada versión nueva, sobre una base que ya existe
```

**Al desplegar esta versión (fase N2) sobre una base de la fase 5a**, correr `./db/migrar.sh`
ANTES de arrancar la imagen nueva: `db/migraciones/001_cloudevents.sql` agrega
`suscripcion.formato` (las que existen quedan `v1`: siguen recibiendo lo mismo), los 15 tipos,
`evento.correlation_id` (a los eventos viejos les pone `corr-<eventId>`) y `evento.traceparent`, y
rehace el índice del feed. Es idempotente y no borra datos; el CI comprueba que `main` + las
migraciones deja la misma base que `db/esquema_notificaciones.sql`.

**`db/reset.sh` borra solo el esquema `notificaciones`, nunca la base.** Contra un host que no es
local exige `CONFIRMAR_RESET=si`, porque borra suscripciones reales (y sus secretos, que no se
pueden recuperar). Sin `psql` en el PATH usa el del contenedor de `docker-compose.yml`.

No se usa `prisma migrate`: la base nace de `db/*.sql` y Prisma solo introspecciona
(`npm run prisma:pull`). Ni `evento` ni `entrega` se borran: son el registro de lo que se recibió y
se envió (una purga de lo viejo y entregado queda en Pendientes, `docs/PLAN.md`).

## Red

- `POST /internal/v1/events` es solo para el core. Exige un token de cliente OAuth con
  `events:publish`, pero conviene además no publicarlo hacia internet (que el gateway solo enrute
  `/flights/v1/webhooks`, `/api/v2/vuelos/webhooks`, `/api/v2/vuelos/eventos`, `/health` y
  `/api/docs`).
- `METRICS_PORT` es para Prometheus por la red interna: nunca por el ingress.
- El servicio necesita salir hacia el JWKS de identity y hacia las URL de los suscriptores (https,
  puerto que elija el tercero). Las URL hacia redes privadas, loopback o la metadata de la nube se
  rechazan al registrar y otra vez al conectar.

## El cliente que publica (el core)

identity_vuelos tiene el scope `events:publish` desde su fase I2 (main). El cliente del core:

```bash
# en identity_vuelos
npm run cliente:crear -- --nombre "Core de vuelos" --scopes "events:publish" --client-id core-vuelos
```

El core pide su token a `POST {JWT_ISSUER}/oauth2/token` con
`grant_type=client_credentials&scope=events:publish` y lo renueva cuando vence (15 minutos).

## Verificación después de desplegar

```bash
BASE=https://notifier.quinde.example
curl -s $BASE/health/ready                                    # 200, database UP
curl -s -o /dev/null -w '%{http_code}\n' $BASE/flights/v1/webhooks   # 401 sin token
curl -s $BASE/flights/v1/webhooks -H "Authorization: Bearer $TOKEN_PERSONA"   # [] o sus suscripciones
curl -s -X POST $BASE/internal/v1/events -H "Authorization: Bearer $TOKEN_CORE" \
  -H 'Content-Type: application/json' -d @evento.json        # 202, y 200 si se repite
curl -s $BASE/api/v2/vuelos/eventos -H "Authorization: Bearer $TOKEN_BOOKING"  # flights:read
curl -s http://<ip-interna>:9464/metrics | grep -E '^(quinde_build_info|notifier_)'
```

Cada respuesta lleva `X-Request-Id`, `X-Correlation-Id` y `X-Trace-Id`. En el log de arranque
tienen que aparecer `Métricas en :9464/metrics`, `Tokens RS256 de <JWT_ISSUER>`, `Conectado a
PostgreSQL` y `EntregaWebhooks: Activo: cada 10 s` (o `Apagado` si se apagó a propósito).
