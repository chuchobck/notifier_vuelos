import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * LA firma de las entregas v2 (CloudEvents): el único lugar donde se decide, para cambiarla sin
 * buscarla por el código.
 *
 * El contrato de Vuelos v2 dice `X-Webhook-Signature: sha256=<HMAC-SHA256(secret, body)>`: el HMAC
 * del cuerpo tal cual se envía, con el secreto de la suscripción. No dice la codificación ni si
 * entra una marca de tiempo. Se eligió hexadecimal en minúsculas (el ejemplo del contrato es hex,
 * y es lo de v1) y sin marca de tiempo (lo que dice el contrato: el cuerpo ya trae `id` y `time`
 * del CloudEvent, que el receptor usa para descartar repeticiones). PENDIENTE DE CONFIRMAR con el
 * docente (docs/EVENTOS.md); si hace falta el formato de v1 (`"<timestamp>.<cuerpo>"` con
 * X-Webhook-Timestamp), se cambia solo aquí.
 */
export const CABECERA_FIRMA_V2 = 'X-Webhook-Signature';

export function firmarCloudEvent(secreto: string, cuerpo: string): string {
  return `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}`;
}

/** Comparación en tiempo constante, para quien recibe (y las pruebas) y quiere verificar. */
export function firmaCloudEventValida(secreto: string, cuerpo: string, firma: string): boolean {
  const esperada = Buffer.from(firmarCloudEvent(secreto, cuerpo));
  const recibida = Buffer.from(firma);
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}

/** Las cabeceras de firma de una entrega v2 (hoy, solo X-Webhook-Signature). */
export function cabecerasDeFirmaV2(secreto: string, cuerpo: string): Record<string, string> {
  return { [CABECERA_FIRMA_V2]: firmarCloudEvent(secreto, cuerpo) };
}
