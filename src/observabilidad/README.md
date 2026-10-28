# src/observabilidad

Trazas (OpenTelemetry, W3C Trace Context) y métricas (prom-client) del notifier, con el estándar de
Quinde: [docs/OBSERVABILIDAD.md del gateway](https://github.com/chuchobck/gateway_vuelos/blob/main/docs/OBSERVABILIDAD.md)
(fase 7e). Ese documento manda; un cambio de nombres, etiquetas o atributos se hace allí primero.

| Archivo | Qué hace |
| --- | --- |
| `traceparent.ts`, `atributos.ts`, `trazas.ts`, `metricas.ts` | **Copiados tal cual del gateway** (`src/observabilidad/`, commit `97cb777`). No se editan aquí |
| `observabilidad.ts` | `Observabilidad`: crea `Trazas`, `Metricas` y `MetricasNotifier`, y sirve `/metrics` en `METRICS_PORT` |
| `express.ts` | El middleware que va **primero**: el span SERVER de cada petición y `X-Trace-Id` (copiado del core) |
| `plantilla-ruta.ts` | La plantilla de la ruta (`/api/v2/vuelos/webhooks/{id}`), para el span, la etiqueta `route` y el log |
| `contexto-traza.ts` | `traceparentActivo()` (se guarda con cada evento recibido) y `contextoDeTraceparent()` (la entrega lo continúa) |
| `metricas-notifier.ts` | Las métricas `notifier_*` (entregas, duración de la entrega, eventos recibidos) |

Los gauges de la bandeja de salida (`notifier_deliveries_pending`,
`notifier_deliveries_oldest_pending_seconds`) se leen de la base al raspar:
`src/modules/entrega/metricas-entregas.ts`.

Reglas que no se rompen:

- Sin instrumentaciones automáticas ni un span por consulta SQL.
- Nada de URLs de webhooks, secretos, firmas, ids, correos, IPs, tokens ni cuerpos en un atributo, una
  etiqueta o una línea de log. Las etiquetas de `notifier_*` son de listas cerradas.
- Un error lleva `error.type` de la lista cerrada, nunca su mensaje.
- La entrega de un webhook a un **tercero** nunca lleva `traceparent` ni `tracestate`.
