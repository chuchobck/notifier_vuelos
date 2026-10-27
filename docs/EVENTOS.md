# Contrato de eventos

El core (backend_vuelos) publica cada hecho de negocio en este servicio con
`POST /internal/v1/events`. El notifier lo guarda una sola vez por `eventId`, lo reparte a las
suscripciones activas del dueño que escuchan ese tipo y lo entrega firmado al tercero, en el
formato de su suscripción: el `WebhookPayload` del contrato 1.5 (suscripciones de
`/flights/v1/webhooks`) o un CloudEvent 1.0 del contrato de Vuelos v2 (suscripciones de
`/api/v2/vuelos/webhooks`). Este documento es el contrato entre los dos lados: qué publica el core,
qué recibe el tercero y cómo cambia un evento sin romper a nadie.

- Esquemas: [`contracts/events/<tipo>.v<mayor>.json`](../contracts/events/) (JSON Schema draft-07,
  uno por tipo y versión mayor).
- Canal: [`contracts/asyncapi.yaml`](../contracts/asyncapi.yaml) (AsyncAPI 3.0, validado en CI).
- Comprobación: `npm run eventos:breaking` (compara con `main`; corre en cada pull request).

## El sobre (lo que publica el core)

```json
{
  "eventId": "5f8d2c1e-7a3b-4e9d-8c6f-000000000000",
  "eventType": "booking.confirmed",
  "schemaVersion": "1.0",
  "occurredAt": "2026-10-16T14:30:00.000Z",
  "ownerId": "0b7c9f4e-3d2a-4b1c-8e5f-6a7b8c9d0e1f",
  "correlationId": "corr-vuelos-7f3a9c",
  "data": { "bookingId": "3f0c6a9e-2b1d-4c8e-9a7f-5d4e3c2b1a09", "pnr": "Q7K2MX", "status": "CONFIRMED" }
}
```

| Campo | Regla |
| --- | --- |
| `eventId` | uuid. Identifica el hecho: el mismo para todas las suscripciones y para cada reintento de publicación. Es la clave de idempotencia |
| `eventType` | Uno de los 15 tipos de `VuelosEventName` del contrato de Vuelos v2 (los 12 de `WebhookSubscription.events` del contrato 1.5 y `hold.created`, `booking.seat_changed` y `flight.status_changed`) |
| `schemaVersion` | `mayor.menor` (`"1.0"`). El mayor elige el archivo (`<tipo>.v1.json`); el menor tiene que estar en su `schemaVersion.enum` |
| `occurredAt` | ISO 8601 en UTC con sufijo `Z` (sin desfase horario). Cuándo pasó el hecho en el core |
| `ownerId` | uuid. El `sub` del token con que se creó el recurso (`id_propietario`). Solo las suscripciones de ese dueño reciben el evento |
| `correlationId` | **Opcional** (desde 1.1; se acepta en cualquier 1.x, también con `"1.0"`). El `X-Correlation-Id` del proceso que originó el hecho, sin cambios (`^[A-Za-z0-9._:-]{1,100}$`). Va al CloudEvent (`correlationid`) y a la cabecera `X-Correlation-Id` de cada entrega. Sin él: el `X-Correlation-Id` de la publicación (el core lo manda si el hecho lo tenía); sin ninguno, el notifier genera `corr-<uuid>` y lo guarda con el evento (el mismo en cada reintento y en el feed) |
| `data` | Lo propio de cada tipo (tabla de abajo). `additionalProperties: false`: nada que el esquema no declare llega al tercero |

El sobre tampoco admite campos de más. Un campo nuevo se agrega **primero al esquema** (cambio
compatible, se despliega el notifier) y **después** el core lo empieza a mandar.

## Lo que recibe el tercero (suscripción v1)

El `WebhookPayload` del contrato GDS Flight Core API 1.5.0.0, el mismo que mandaba el core (y el
mismo, byte a byte, que mandaba este servicio en la fase 5a: lo comprueba `test/v2.e2e-spec.ts`):

```json
{
  "eventId": "5f8d2c1e-7a3b-4e9d-8c6f-000000000000",
  "eventType": "booking.confirmed",
  "occurredAt": "2026-10-16T14:30:00.000Z",
  "apiVersion": "1.5.0",
  "data": { "bookingId": "3f0c6a9e-2b1d-4c8e-9a7f-5d4e3c2b1a09", "pnr": "Q7K2MX", "status": "CONFIRMED" }
}
```

- `occurredAt` sale normalizado con milisegundos (`toISOString`), como lo armaba el core.
- `apiVersion` es `1.5.0` (el `info.version` del contrato del core sin el cuarto número). No es la
  `schemaVersion` del sobre: esa es un acuerdo entre el core y el notifier.
- El cuerpo se arma y se congela al recibir el evento: cada reintento envía exactamente los mismos
  bytes.
- Cabeceras: `Content-Type: application/json`, `X-Webhook-Event` (el `eventType`), `X-Webhook-Id`
  (el `eventId`), `X-Webhook-Timestamp` (segundos desde 1970) y
  `X-Webhook-Signature: sha256=<hex>`, el HMAC-SHA256 de `"<timestamp>.<cuerpo>"` con el secreto
  de la suscripción. Iguales a las del core: un tercero no cambia nada al pasar al notifier.
- Lo único nuevo desde la fase N2 es la cabecera `X-Correlation-Id` (fuera del cuerpo y de la
  firma). Ni `correlationId` ni nada de v2 entra al cuerpo.

## Lo que recibe el tercero (suscripción v2: CloudEvents 1.0)

Un `VuelosCloudEvent` del contrato de Vuelos v2 en **modo estructurado** (el CloudEvent entero es el
cuerpo), armado por el traductor `src/modules/evento/traductores/cloudevent.v2.ts` (patrón Message
Translator: evento interno → CloudEvent) y congelado al recibir el evento:

```http
POST <url de la suscripción>
Content-Type: application/cloudevents+json
X-Webhook-Signature: sha256=<hex del HMAC-SHA256 del cuerpo con el secreto>
X-Correlation-Id: corr-vuelos-7f3a9c

{"id":"5f8d2c1e-…","data":{"pnr":"Q7K2MX","status":"CONFIRMED","bookingId":"3f0c6a9e-…"},
 "time":"2026-10-16T14:30:00.000Z","type":"ec.edu.epn.booking.vuelos.booking.confirmed",
 "source":"/aerolineas/quinde/vuelos","subject":"3f0c6a9e-…","specversion":"1.0",
 "correlationid":"corr-vuelos-7f3a9c","datacontenttype":"application/json"}
```

| Atributo | Valor |
| --- | --- |
| `specversion` | `"1.0"` |
| `type` | `ec.edu.epn.booking.vuelos.<eventType>` |
| `source` | `/aerolineas/<AIRLINE_CODE>/vuelos` (`AIRLINE_CODE`, por defecto `quinde`) |
| `id` | El `eventId`: el mismo en cada reintento, en cada suscripción y en el feed (para deduplicar) |
| `time` | El `occurredAt`, en UTC con milisegundos |
| `subject` | El `holdId` en `hold.*`, `<flightNumber>/<date>` en `flight.status_changed` y el `bookingId` en los demás (los `flight.*` de v1 son uno por reserva) |
| `datacontenttype` | `application/json` |
| `correlationid` | La extensión del contrato: el correlationId del evento (ver el sobre) |
| `data` | El `data` del sobre, tal cual |

El orden de las claves es el de jsonb (como el cuerpo v1): el receptor tiene que firmar o verificar
**los bytes que recibió**, nunca un JSON vuelto a serializar.

**Firma (pendiente de confirmar con el docente).** El contrato dice `X-Webhook-Signature:
sha256=<HMAC-SHA256(secret, body)>`. Se implementó así: HMAC-SHA256 del cuerpo tal cual, con el
secreto de la suscripción, en **hexadecimal** en minúsculas y **sin marca de tiempo** (el contrato
no dice la codificación; el ejemplo es hex). Si hubiera que usar el formato de v1
(`"<timestamp>.<cuerpo>"` más `X-Webhook-Timestamp`), se cambia en un solo lugar:
`src/modules/compartido/firma-cloudevents.ts`. Ninguna entrega (v1 ni v2) lleva `traceparent` ni
`tracestate`.

**Reintentos v2:** los del contrato (`createWebhook`): 1, 5, 30, 120 y 360 minutos, 6 intentos;
después, `FALLIDO`. Lo que no llegó sigue en el feed.

**Validación contra el contrato.** Cada CloudEvent se valida en las pruebas contra
`VuelosCloudEvent` y el `Event*` de su tipo (`test/utils/contrato-v2.ts`, sobre una copia tal cual
del contrato en `test/contratos/`). El contrato no tiene `Event*` para `booking.ticket_issuing`,
`booking.ticket_failed`, `flight.schedule_changed` ni `flight.cancelled` (están en
`VuelosEventName` pero no en el `oneOf` de `VuelosCloudEvent`): esos se validan contra
`CloudEventBase`. Es una diferencia del contrato que conviene reportar.

## El feed (GET /api/v2/vuelos/eventos)

`listOutboxEvents` del contrato v2, el respaldo de los webhooks: los CloudEvents del **dueño del
token** (scope `flights:read`), los mismos que se entregan, en orden de llegada al notifier.

- `limit` de 1 a 100 (20 por defecto); `type` filtra por un `VuelosEventName`.
- `after` es el `id` (eventId) del último evento ya leído; devuelve los que llegaron después. Uno
  desconocido o de otro dueño es 400 (los dos iguales: no se revela si existe).
- `metadata`: `total` (los de esta página), `next_after` (el `id` del último de la página, para
  pedir la siguiente o volver más tarde; `null` si la página vino vacía) y `timestamp`.

```json
{ "events": [ { "specversion": "1.0", "type": "ec.edu.epn.booking.vuelos.booking.confirmed", "…": "…" } ],
  "metadata": { "total": 1, "next_after": "5f8d2c1e-…", "timestamp": "2026-10-27T05:00:00.000Z" } }
```

## `data` por tipo (esquemas v1, menores 1.0 y 1.1)

| Tipo | Campos de `data` (obligatorios salvo que se diga) |
| --- | --- |
| `booking.confirmed`, `booking.failed`, `booking.changed`, `booking.baggage_added`, `booking.ticket_issuing`, `booking.ticket_issued`, `booking.ticket_failed`, `booking.checked_in` | `bookingId` (uuid), `pnr` (`^[A-Z0-9]{6}$`), `status` (`BookingDetail.status`: `PENDING`, `PENDING_PAYMENT`, `TICKET_ISSUING`, `CONFIRMED`, `FAILED`, `CHANGE_PENDING`, `CANCELLATION_PENDING`, `CANCELLED`) |
| `booking.cancelled` | Los mismos tres, y `refundAmount` **opcional** (texto decimal, `"35.00"`): solo si la cancelación tuvo una cotización aceptada |
| `hold.expired` | `holdId` (uuid) y `status` (siempre `EXPIRED`) |
| `flight.schedule_changed`, `flight.cancelled` | `bookingId`, `pnr`, `status`, `flightNumber` (`^[A-Z0-9]{2}[1-9][0-9]{0,3}$`, como `EQ1234`) y `segmentId` (uuid de la salida). Un evento por cada reserva viva de esa salida, cada uno con su `eventId` |

Desde **1.1** (todo opcional, nada se volvió obligatorio; aceptado también con `"1.0"`):

| Tipo | Campos opcionales nuevos de `data` (contrato v2) |
| --- | --- |
| Los 10 `booking.*` | `ownerId` (el usuario final, `X-User-Id` de Booking), `partnerOrderId` y `packageId` (texto o `null`), `grandTotal` (`MoneyAmount`: `currency`, `total` y opcionales `baseFare` y `taxes`, en texto decimal) |
| `booking.failed` | `errorCode` (`PNR_CREATION_FAILED`...) |
| `booking.ticket_issued` | `paymentReference`, `tickets` (`ticketId`, `eTicketNumber` y `passengerId` opcional) |
| `booking.changed`, `booking.baggage_added`, `booking.seat_changed` | `changeType` (`DATE_CHANGE`, `BAGGAGE`, `SEAT`), `amountCharged` (`MoneyAmount`), `paymentReference` (o `null`) |
| `booking.cancelled` | `reasonCode` (`SAGA_COMPENSATION`...), `refundId`, `seatsReleased` (además del `refundAmount` de 1.0) |
| `booking.checked_in` | `passengersCheckedIn` |
| `hold.expired` | `seatsReleased`, `expiredAt` |

Los 3 tipos nuevos del contrato v2 nacen en su `v1` y **solo los reciben las suscripciones v2** (no
son de los 12 del contrato 1.5):

| Tipo | `data` |
| --- | --- |
| `hold.created` | `holdId` (uuid) y `expiresAt` (UTC); opcionales `offerId` y `seatsHeld` |
| `booking.seat_changed` | Lo de una reserva (`bookingId`, `pnr`, `status`, más los opcionales comunes) y los de un cambio |
| `flight.status_changed` | `flightNumber` (`^[A-Z0-9]{2}[0-9]{1,4}$`), `date` (`YYYY-MM-DD`) y `newStatus` (`FlightOperationalStatus`); opcionales `previousStatus`, `estimatedDepartureAt`, `estimatedArrivalAt`, `delayMinutes` (o `null`), `destination` y `affectedBookingIds`. Un evento por dueño afectado |

`flight.schedule_changed`, `flight.cancelled` y `booking.ticket_issuing` se mantienen (el contrato v2
los conserva por compatibilidad; los suscriptores nuevos deberían usar `flight.status_changed`).

`status` es el de la reserva **en el momento del evento**, no el de ahora (`booking.ticket_issued`
llega con `TICKET_ISSUING`). Son los campos que el core ya mandaba en su `INSERT ... SELECT` de la
fase 10; ninguno es un dato personal del pasajero.

## Versiones y compatibilidad

Cada archivo cubre **una versión mayor** de un tipo y lista en `schemaVersion.enum` los menores que
acepta. Dentro de un mayor solo se hacen cambios **compatibles**: el core puede seguir publicando lo
de antes y el tercero sigue recibiendo lo que esperaba.

| Cambio | ¿Compatible? | Cómo se hace |
| --- | --- | --- |
| Agregar un campo **opcional** | Sí | En el mismo archivo; si el core lo va a mandar, se agrega también un menor (`"1.1"`) a `schemaVersion.enum` |
| Agregar un valor a un `enum` (un menor de `schemaVersion`, un estado nuevo) | Sí | En el mismo archivo |
| Cambiar `title`, `description` o `examples` | Sí | En el mismo archivo |
| Quitar o renombrar un campo | **No** | Versión mayor nueva |
| Volver obligatorio un campo opcional, o agregar uno nuevo obligatorio | **No** | Versión mayor nueva |
| Volver opcional un campo obligatorio | **No** (el tercero contaba con él) | Versión mayor nueva |
| Cambiar el tipo, el formato, el patrón, un largo o cualquier restricción | **No** | Versión mayor nueva |
| Quitar un valor de un `enum` | **No** | Versión mayor nueva |
| Borrar el archivo de una versión | **No** | Solo cuando el core ya no la publique (y en un pull request que lo diga) |

Una versión mayor nueva es otro archivo, `<tipo>.v2.json`, con `schemaVersion.enum: ["2.0"]`.
**Convive con la v1**: el notifier acepta las dos y el core pasa de una a otra cuando quiera. La v1
se borra recién cuando el core deja de publicarla (ese pull request falla en `eventos:breaking` a
propósito y se aprueba a mano).

### `npm run eventos:breaking`

Compara cada archivo de `contracts/events` con el de `origin/main` (u otra referencia:
`npm run eventos:breaking -- origin/otra`) y sale con:

- `0` si todo es compatible (un archivo nuevo, una versión mayor nueva, un campo opcional, un valor
  más en un enum, cambios de texto);
- `1` si hay un cambio incompatible o un archivo mal formado (nombre que no es
  `<tipo>.v<mayor>.json`, un tipo que no es de los 15, `eventType` distinto del nombre, versiones de
  otro mayor, un sobre sin sus seis campos o sin `additionalProperties: false`);
- `2` si no pudo comparar (la referencia no existe: `git fetch origin main`).

El servicio aplica las mismas reglas de forma al arrancar: con un archivo mal formado, o sin el v1
de alguno de los 15 tipos, no levanta.

**Por qué la fase N2 no creó archivos `.v2.json`.** Todo lo que pide el contrato v2 en el sobre y
en `data` es opcional: por la regla de arriba es un cambio compatible y va como menor `1.1` en el
mismo archivo (`eventos:breaking` lo da por compatible). Un `<tipo>.v2.json` solo hará falta el día
que algo se quite, cambie o se vuelva obligatorio.

## Respuestas de `POST /internal/v1/events`

| Status | Cuándo |
| --- | --- |
| `202` | Primera vez de ese `eventId`: el evento y sus entregas quedaron guardados (después del commit) |
| `200` | El `eventId` ya existía con el mismo contenido: no se duplicó nada |
| `400` | El cuerpo no cumple el esquema de su tipo y versión (`invalidParams` nombra cada campo) |
| `401` / `403` / `503` | Token ausente o inválido / sin `events:publish` o de una persona / JWKS de identity no disponible |
| `409` | El `eventId` ya existía con **otro** contenido (un error del publicador) |
| `415` / `413` | No es `application/json` / más de 100 kB |
| `422` | `eventType` que no es uno de los 15, o `schemaVersion` que no tiene esquema |
| `429` | Más de `EVENTS_RATE_LIMIT_MAX` publicaciones por minuto desde la misma IP |

Cuerpo de `200` y `202`: `{ "eventId": "...", "deliveries": 2, "duplicate": false }`
(`deliveries` es cuántas entregas tiene el evento).

Para el publicador: `400`, `403`, `409`, `413`, `415` y `422` son errores suyos (no sirve
reintentar); `429`, `503` y cualquier `5xx` se reintentan con espera. Como la publicación es
idempotente por `eventId`, reintentar un evento que en realidad sí se guardó da `200`.
