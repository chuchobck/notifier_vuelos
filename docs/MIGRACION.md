# Migración de las suscripciones del core

Las suscripciones a webhooks viven hoy en el core (`vuelos.webhook_cabecera` y
`vuelos.webhook_detalle`). Para que el notifier las atienda sin que ningún tercero cambie nada (ni
su URL, ni su secreto, ni la forma en que verifica la firma), el core las exporta a un archivo y este
servicio las importa. El exportador lo escribe el core en la fase 5b; aquí están el formato que
tiene que producir y la herramienta que lo lee.

## Formato del archivo

[JSON Lines](https://jsonlines.org/): UTF-8, **una suscripción por línea**, cada línea un objeto
JSON. Las líneas vacías se ignoran.

```json
{"id":"2e9dba42-a47d-49c6-bf82-33612cae4149","idPropietario":"0b7c9f4e-3d2a-4b1c-8e5f-6a7b8c9d0e1f","url":"https://partner.example.com/hooks/vuelos","secretoCifrado":"v1.Qk3x…","eventos":["booking.confirmed","booking.cancelled"],"activo":true,"fechaCreacion":"2026-10-06T15:04:05.000Z"}
```

| Campo | Obligatorio | Del core | Regla |
| --- | --- | --- | --- |
| `id` | Sí | `webhook_cabecera.id` | uuid. Se conserva: el tercero puede tener guardado el id para su `DELETE` |
| `idPropietario` | Sí | `webhook_cabecera.id_propietario` | Texto de 1 a 200 caracteres (el `sub` del dueño) |
| `url` | Sí | `webhook_cabecera.url` | `^https?://\S+$`, hasta 2048 caracteres. Se guarda tal cual |
| `secretoCifrado` | Sí | `webhook_cabecera.secreto` | El valor cifrado **tal como está en la base**, `v1.<base64url>`. Nunca el secreto en claro |
| `eventos` | Sí | `webhook_detalle` → `tipo_evento.codigo` | Lista no vacía, sin repetidos, de los 12 tipos del contrato |
| `activo` | Sí | `webhook_cabecera.activo` | `true` o `false`. Las dadas de baja también se importan (quedan inactivas) |
| `fechaCreacion` | No | `webhook_cabecera.fecha_creacion` | ISO 8601 (UTC), no en el futuro. Conserva el orden de `GET /webhooks`; sin ella, la hora de la importación |

Ningún otro campo se acepta: una línea con un campo de más se rechaza (así un exportador que
agregue, por ejemplo, el secreto en claro falla en vez de pasar en silencio).

## Por qué el secreto no se descifra ni se vuelve a cifrar

El notifier cifra con el mismo algoritmo que el core (AES-256-GCM con la clave derivada por HKDF de
`WEBHOOK_SECRET_KEY`, sal `quinde-vuelos`, info `webhook-secreto`) y guarda el mismo formato
`v1.<base64url>`. Con **la misma `WEBHOOK_SECRET_KEY` en los dos servicios**, el valor exportado se
guarda tal cual y se descifra aquí para firmar cada entrega. El secreto en claro nunca sale de un
proceso: no viaja en el archivo ni aparece en la salida de ninguna herramienta.

Por eso el importador **rechaza la línea cuyo secreto no se puede descifrar** con la clave actual:
esa suscripción no podría firmar ninguna entrega. Si se rechazan todas, lo más probable es que
`WEBHOOK_SECRET_KEY` no sea la del core.

## Importar

```bash
# DATABASE_URL y WEBHOOK_SECRET_KEY del entorno o del .env (la MISMA clave del core)
npm run suscripciones:importar -- suscripciones.jsonl

# dentro de la imagen desplegada
docker exec -it <contenedor> node dist/cli/importar-suscripciones.js /ruta/suscripciones.jsonl
```

Salida (sin secretos ni URL: de una línea rechazada, su número y el campo que falló):

```text
Importación de suscripciones desde suscripciones.jsonl
  línea 3: rechazada (eventos: debe ser una lista sin repetidos de: booking.confirmed, ...)
  línea 6: rechazada (secretoCifrado: no se puede descifrar con la WEBHOOK_SECRET_KEY actual)
Importadas: 41 · ya existían: 0 · rechazadas: 2
```

| Código de salida | Significado |
| --- | --- |
| `0` | Ninguna línea rechazada |
| `1` | Alguna línea rechazada (las demás sí se importaron) |
| `2` | No pudo empezar (falta el archivo, `DATABASE_URL` o `WEBHOOK_SECRET_KEY`) o falló la base |

Reglas:

- **Idempotente**: una suscripción cuyo `id` ya existe no se toca y cuenta como "ya existía".
  Correrlo dos veces con el mismo archivo (o con uno que se cortó a la mitad) no duplica nada.
- Cada línea va en su propia transacción, con su registro en `auditoria`
  (`SUSCRIPCION_IMPORTADA`, sin actor, con el host de la URL y `IMPORTADA_INACTIVA` si llega dada de
  baja). Una línea rechazada no deja nada.
- Se rechaza una suscripción **activa** si el dueño ya tiene otra activa con la misma URL (la regla
  del 409 de `POST /webhooks`).
- No se exige el máximo de 10 activas por dueño ni se vuelve a resolver el DNS de la URL: el core ya
  lo validó al registrarla, y la protección SSRF se vuelve a aplicar en cada entrega.

## Orden del corte (fase 5b)

1. Desplegar el notifier con la misma `WEBHOOK_SECRET_KEY` del core.
2. Que el core empiece a publicar sus eventos en `POST /internal/v1/events` (los guarda en su bandeja
   y los publica, con reintentos; la publicación es idempotente por `eventId`).
3. Exportar e importar las suscripciones. Repetir la importación justo antes del paso 4 recoge las
   que se crearon en el medio (las que ya estaban cuentan como "ya existían").
4. Enrutar `GET/POST/DELETE /flights/v1/webhooks` al notifier y apagar la entrega del core
   (`WEBHOOK_DELIVERY_JOB_ENABLED=false` en el core) **en el mismo despliegue**, para que un evento no
   salga dos veces (por el core y por el notifier). Si se solapan unos segundos, el tercero recibe el
   mismo `X-Webhook-Id` dos veces: la entrega ya es "al menos una vez" y se descarta por ese id.
