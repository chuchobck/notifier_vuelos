import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * Protección contra SSRF: a qué direcciones puede apuntar un webhook. Se aplica al registrar (con
 * la resolución de DNS del momento) y otra vez al entregar, sobre la dirección a la que realmente
 * se conecta (ver ClienteWebhookHttp), para que un nombre que cambie de dueño después (DNS
 * rebinding) no llegue a la red interna.
 *
 * Siempre bloqueado: redes privadas (10/8, 172.16/12, 192.168/16, fc00::/7), link-local y
 * metadata de la nube (169.254/16, fe80::/10), compartido de operador (100.64/10), "esta red"
 * (0/8), multicast y reservadas. El loopback (127/8, ::1) solo se permite fuera de producción.
 */
const PROHIBIDAS = new BlockList();
for (const [red, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PROHIBIDAS.addSubnet(red, bits, 'ipv4');
}
for (const [red, bits] of [
  ['::', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PROHIBIDAS.addSubnet(red, bits, 'ipv6');
}
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

export interface OpcionesDestino {
  /** NODE_ENV === 'production': exige https y no admite loopback. */
  produccion: boolean;
}

/** Una dirección IPv6 "IPv4-mapped" (::ffff:10.0.0.1) se juzga como la IPv4 que lleva dentro. */
function normalizar(ip: string): { ip: string; familia: 'ipv4' | 'ipv6' } {
  const mapeada = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapeada) return { ip: mapeada[1], familia: 'ipv4' };
  return { ip, familia: isIP(ip) === 6 ? 'ipv6' : 'ipv4' };
}

/** Si una dirección IP concreta no es un destino permitido. */
export function direccionProhibida(direccion: string, { produccion }: OpcionesDestino): boolean {
  const { ip, familia } = normalizar(direccion);
  if (PROHIBIDAS.check(ip, familia)) return true;
  return produccion && LOOPBACK.check(ip, familia);
}

export type MotivoDestino =
  | 'must be a valid URL'
  | 'must use https'
  | 'must not include credentials'
  | 'host cannot be resolved'
  | 'host resolves to a network that is not allowed';

/**
 * Devuelve por qué la URL no es un destino válido, o null si lo es. Resuelve el nombre y exige
 * que TODAS sus direcciones sean permitidas.
 */
export async function motivoDestinoInvalido(
  texto: string,
  opciones: OpcionesDestino,
): Promise<MotivoDestino | null> {
  let url: URL;
  try {
    url = new URL(texto);
  } catch {
    return 'must be a valid URL';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !opciones.produccion)) {
    return 'must use https';
  }
  if (url.username !== '' || url.password !== '') return 'must not include credentials';
  // [::1] llega con corchetes
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let direcciones: string[];
  try {
    direcciones = (await lookup(host, { all: true })).map((d) => d.address);
  } catch {
    return 'host cannot be resolved';
  }
  if (direcciones.length === 0) return 'host cannot be resolved';
  if (direcciones.some((d) => direccionProhibida(d, opciones))) {
    return 'host resolves to a network that is not allowed';
  }
  // En desarrollo, http solo hacia loopback: un http a otro host sigue sin ser buena idea
  if (
    url.protocol === 'http:' &&
    !direcciones.every((d) => LOOPBACK.check(normalizar(d).ip, normalizar(d).familia))
  ) {
    return 'must use https';
  }
  return null;
}
