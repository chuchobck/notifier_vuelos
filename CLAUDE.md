# CLAUDE.md

Reglas permanentes del proyecto. Léelas antes de tocar código.

## Proyecto

Quinde · Notifier: el servicio de webhooks del sistema de vuelos (Reto 2 de Integración de
Sistemas, PUCE, fase 5a). NestJS 10 + TypeScript estricto + Prisma 7 + PostgreSQL (base propia,
esquema `notificaciones`). Se queda con lo que antes hacía el core
(`github.com/chuchobck/backend_vuelos`): las suscripciones (`/flights/v1/webhooks` del contrato GDS
Flight Core API 1.5.0.0, idénticas), el reparto de cada evento a las suscripciones que lo escuchan y
la entrega firmada con reintentos. El core le publica sus eventos en `POST /internal/v1/events`.
Los tokens los emite identity_vuelos (RS256, JWKS). El plan y el estado están en `docs/PLAN.md`;
el contrato de eventos, en `docs/EVENTOS.md`; la migración, en `docs/MIGRACION.md`; el despliegue,
en `docs/DEPLOY.md`.

## Alcance

- Solo webhooks: suscripciones, eventos recibidos, entregas y su auditoría. Nada de reservas.
- Desde este repo no se toca el core, identity, el BFF ni los frontends.
- `/flights/v1/webhooks` responde exactamente como el core (mismo scope, cuerpos, errores, textos).
  Un cambio ahí es un cambio del contrato del core: no se hace aquí por cuenta propia.

## Idioma

- Código, carpetas, comentarios y base de datos en español.
- Rutas y JSON hacia afuera en inglés, como el contrato. Un mapper por entidad traduce.

## Estructura

- Por capas, como el core: `<entidad>.routes.ts` → controller → service → repository (el único
  archivo que usa Prisma), mapper y `dto/`. Una sola tabla de rutas: `src/routes/index.routes.ts`.
- `src/modules/`: `suscripcion` (API y la importación), `evento` (API interna y `contrato/`: los
  esquemas y las reglas de compatibilidad), `entrega` (el proceso y el HTTP), `compartido`
  (cifrado, firma, SSRF, los 12 tipos), `auditoria`, `auth` (el verificador de la fase 4b) y `salud`.
- `src/cli/`: `suscripciones:importar`, `eventos:breaking` y `openapi:export`, compiladas con el
  resto: también corren dentro de la imagen.
- Rutas: `/flights/v1/webhooks`, `/internal/v1/events`, `/health`. Swagger en `/api/docs`.

## Contrato de eventos

- El sobre (`eventId`, `eventType`, `schemaVersion`, `occurredAt`, `ownerId`, `data`) se valida con
  `contracts/events/<tipo>.v<mayor>.json`. Un archivo por tipo y versión mayor; el `$id` termina en
  su nombre. Lo que recibe el tercero es el `WebhookPayload` del contrato del core.
- Compatible dentro de un mayor: agregar un campo opcional o un valor de enum, cambiar textos.
  Quitar, renombrar, volver obligatorio u opcional, o cambiar una restricción va en un `v2` que
  convive con el `v1`. `npm run eventos:breaking` lo comprueba contra `main` y falla en los PR.
- `data` y el sobre llevan `additionalProperties: false`: un campo nuevo entra primero al esquema y
  después lo publica el core. Nada sin declarar llega a un tercero.
- Los 12 tipos viven en tres lugares que cambian juntos: `EVENTOS_WEBHOOK`
  (`src/modules/compartido/eventos-webhook.ts`), `fn_es_tipo_evento` (`db/`) y `contracts/events/`.
- `contracts/asyncapi.yaml` describe los dos canales; el CI lo valida.

## Seguridad

- Toda ruta exige un token de identity_vuelos salvo las de `@Publico()`. El verificador es el del
  core (fase 4b): RS256 fijo (nunca se lee del token), `kid`, `typ` at+jwt, `iss` y `aud` texto a
  texto, `exp`; sin claves, 503 `AUTH_UNAVAILABLE`, nunca 401 ni dejar pasar.
- Publicar exige `events:publish` y un token de cliente OAuth (`@SoloClientesOAuth()`): el de una
  persona es 403 aunque traiga el scope.
- El dueño es el `sub` del token (`@UsuarioActual()`). Una suscripción ajena es 404.
- Nunca registrar ni devolver tokens, secretos (en claro o cifrados), firmas, la URL de un webhook
  ni el cuerpo de un evento: tampoco en errores ni en la auditoría (que guarda solo el host). El
  error nombra el campo, no el valor. `test/escaneo.e2e-spec.ts` lo comprueba.
- El secreto se cifra con `CifradoSecreto` (AES-256-GCM, HKDF con sal `quinde-vuelos` e info
  `webhook-secreto`, formato `v1.`): el del core. Cambiar la sal, la info o el formato rompe la
  migración de los secretos del core.
- Un webhook solo se envía desde `EntregaWebhooks` y por `ClienteWebhook`, nunca dentro de una
  transacción. Su URL se valida contra SSRF al registrar y otra vez al conectar (sobre la dirección
  resuelta), y no se siguen redirecciones.
- Toda petición con cuerpo es `application/json` (otro tipo: 415). Máximo 100 kB.

## Datos

- La base es la fuente de verdad (`db/esquema_notificaciones.sql`); no se usa `prisma migrate`.
  `db/reset.sh` borra solo el esquema `notificaciones`, nunca la base.
- Eliminación lógica siempre (la extensión de Prisma bloquea `delete`). `evento` y `entrega` no se
  borran; `auditoria` es de solo inserción (un trigger lo impone).
- Un evento se guarda y se reparte en UNA transacción; la respuesta sale después del commit. El
  `eventId` es único: la publicación es idempotente (202, 200 si se repite, 409 con otro contenido).
- Una entrega se toma con `FOR UPDATE SKIP LOCKED` y un arrendamiento, y su resultado se anota con
  un UPDATE condicionado al intento tomado. Las reglas (`REGLAS_ENTREGA`) son las del core.
- Un vencimiento se decide con la hora del `Reloj` (`src/common/reloj.ts`), no con `new Date()`:
  las pruebas lo adelantan.
- SQL crudo solo con plantillas etiquetadas y tablas calificadas `notificaciones.`.
- Las fechas van en UTC. Ningún `.json` con el mismo nombre base que un `.ts`.

## Pruebas

- Jest + supertest contra PostgreSQL real, con una identidad falsa (par RSA y JWKS por HTTP) y un
  receptor falso real. Las pruebas no borran: usan dueños al azar y al final dan de baja sus
  suscripciones.
- Una prueba nueva se comprueba rompiendo a propósito lo que cubre; si es de seguridad, su mutación
  va a `scripts/mutaciones.mjs` (`npm run test:mutaciones`).
- `contracts/notifier-openapi.json` se regenera con `npm run openapi:export`; una prueba falla si
  quedó desactualizado.

## Git

- Commits en Conventional Commits y en español: `tipo(ámbito): verbo en infinitivo y qué cambia`.
- Un commit por paso, y cada uno pasa `npm run lint`, `npm run format:check` y `npm run build`.
- Una rama por fase. Push solo de esa rama, al cerrar la fase y ya verificada; nunca a `main`,
  nunca `--force`, nunca reescribir commits subidos. El merge lo hace el dueño del repo.
- Nunca claves, secretos, `.env` ni archivos de migración (`*.jsonl`) en git.

## Verificación

- Verificar con `curl` o pruebas, no solo compilando. CI (`.github/workflows/ci.yml`) corre lint,
  formato, tipos, build, la suite e2e con PostgreSQL, el AsyncAPI, `eventos:breaking` (en PR) y la
  construcción de la imagen.
- Una variable de entorno nueva va en `src/config/entorno.ts`, `.env.example` y `docs/DEPLOY.md`.
- Al terminar cada fase: actualizar `docs/PLAN.md` y entregar un resumen con qué se verificó, qué
  no se pudo verificar y qué se decidió sin consultar.
