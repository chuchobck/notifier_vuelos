import { TipoEvento } from '../compartido/eventos-webhook';
import { FormatoEntrega } from '../evento/traductores/evento-interno';

export type { FormatoEntrega };

/** Máximo de suscripciones activas por usuario (el mismo del core). */
export const MAXIMO_SUSCRIPCIONES_ACTIVAS = 10;

/** Límite propio de POST /webhooks: cada alta resuelve DNS. 10 por minuto e IP (como el core). */
export const LIMITE_ALTA_WEBHOOK = { limite: 10, ventanaSegundos: 60 };

/** Una suscripción activa de un usuario. El secreto llega cifrado; el repository no lo ve en claro. */
export interface Suscripcion {
  id: string;
  url: string;
  eventos: TipoEvento[];
  fechaCreacion: Date;
  /** El secreto cifrado (`v1.…`), tal como está en la base. */
  secretoCifrado: string;
}

/** Lo que sale hacia el controller: el secreto ya enmascarado. */
export interface SuscripcionVista {
  id: string;
  url: string;
  eventos: TipoEvento[];
  secretoEnmascarado: string;
  fechaCreacion: Date;
}
