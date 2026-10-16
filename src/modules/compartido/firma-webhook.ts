import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Firma de una entrega: HMAC-SHA256, con el secreto de la suscripción, de `<timestamp>.<cuerpo>`
 * (timestamp en segundos de época, el mismo de X-Webhook-Timestamp). Incluir el timestamp deja
 * al receptor rechazar una entrega repetida fuera de su ventana. Va como `sha256=<hex>`.
 */
export function firmar(secreto: string, timestamp: number, cuerpo: string): string {
  return `sha256=${createHmac('sha256', secreto).update(`${timestamp}.${cuerpo}`).digest('hex')}`;
}

/** Comparación en tiempo constante, para quien recibe (y las pruebas) y quiere verificar. */
export function firmaValida(
  secreto: string,
  timestamp: number,
  cuerpo: string,
  firma: string,
): boolean {
  const esperada = Buffer.from(firmar(secreto, timestamp, cuerpo));
  const recibida = Buffer.from(firma);
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}
