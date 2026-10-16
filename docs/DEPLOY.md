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
| `DB_PORT` | No (solo `docker-compose.yml`) | `5434` | 5434 |

Generar la clave de los secretos (solo si el core todavía no tiene una; si la tiene, usar esa):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Los límites propios (10 altas de suscripción por minuto e IP, 10 suscripciones activas por
usuario) y las reglas de entrega (5 intentos, esperas de 1, 5, 30 y 120 minutos, plazo de 5 s,
baja tras 10 fallidas seguidas) están en el código, no en el entorno: son las del core.

## Base de datos

Una base `notifier_db` (en Neon, otra base del mismo proyecto; en local, el `docker-compose.yml` de
este repo en el puerto 5434). El esquema `notificaciones` no apunta a ninguna tabla del core ni de
identity: las credenciales de esta base no abren las otras.

```bash
DATABASE_URL="postgresql://...@host/notifier_db?schema=notificaciones&sslmode=require" \
  CONFIRMAR_RESET=si ./db/reset.sh          # solo la primera vez: crea el esquema
```

**`db/reset.sh` borra solo el esquema `notificaciones`, nunca la base.** Contra un host que no es
local exige `CONFIRMAR_RESET=si`, porque borra suscripciones reales (y sus secretos, que no se
pueden recuperar). Sin `psql` en el PATH usa el del contenedor de `docker-compose.yml`.

No se usa `prisma migrate`: la base nace de `db/*.sql` y Prisma solo introspecciona
(`npm run prisma:pull`). Ni `evento` ni `entrega` se borran: son el registro de lo que se recibió y
se envió (una purga de lo viejo y entregado queda en Pendientes, `docs/PLAN.md`).

## Red

- `POST /internal/v1/events` es solo para el core. Exige un token de cliente OAuth con
  `events:publish`, pero conviene además no publicarlo hacia internet (que el balanceador solo
  enrute `/flights/v1/webhooks`, `/health` y `/api/docs`).
- El servicio necesita salir hacia el JWKS de identity y hacia las URL de los suscriptores (https,
  puerto que elija el tercero). Las URL hacia redes privadas, loopback o la metadata de la nube se
  rechazan al registrar y otra vez al conectar.

## El cliente que publica (el core)

identity_vuelos todavía no tiene el scope `events:publish` (ver Pendientes en `docs/PLAN.md`).
Cuando lo tenga:

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
```

En el log de arranque tienen que aparecer `Tokens RS256 de <JWT_ISSUER>`, `Conectado a
PostgreSQL` y `EntregaWebhooks: Activo: cada 10 s` (o `Apagado` si se apagó a propósito).
