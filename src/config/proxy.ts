import { isIP } from 'node:net';

/**
 * `TRUST_PROXY`: cuántos proxies hay entre el cliente y el servicio, para que `req.ip` sea la IP
 * del cliente (la de X-Forwarded-For) y no la del proxy. De eso dependen el límite de
 * peticiones por IP y `app.direccion_ip` de la auditoría.
 *
 *   false (o vacía)  Sin proxy: se usa la IP del socket. Valor por defecto, también en local.
 *   1                Un proxy delante (un balanceador): se confía solo en el último salto.
 *   2, 3...          Esa cantidad de saltos.
 *   loopback, 10.0.0.0/8, ...   Lista de IP, CIDR o nombres (loopback, linklocal, uniquelocal)
 *                    que se consideran proxies de confianza.
 *
 * `true` no se acepta: confiaría en cualquier X-Forwarded-For y cualquiera podría falsear su IP.
 */
export type ValorTrustProxy = false | number | string[];

const NOMBRES = new Set(['loopback', 'linklocal', 'uniquelocal']);

export function parsearTrustProxy(valor: string | undefined): ValorTrustProxy | undefined {
  const texto = (valor ?? '').trim();
  if (texto === '' || texto.toLowerCase() === 'false' || texto === '0') return false;
  if (/^[1-9]\d{0,2}$/.test(texto)) return Number(texto);

  const elementos = texto.split(',').map((elemento) => elemento.trim());
  return elementos.every(esConfianzaValida) ? elementos : undefined;
}

function esConfianzaValida(elemento: string): boolean {
  if (NOMBRES.has(elemento)) return true;
  const [ip, mascara, ...resto] = elemento.split('/');
  if (resto.length > 0 || isIP(ip) === 0) return false;
  if (mascara === undefined) return true;
  const maximo = isIP(ip) === 4 ? 32 : 128;
  return /^\d{1,3}$/.test(mascara) && Number(mascara) <= maximo;
}
