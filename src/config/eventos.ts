/**
 * El código de la aerolínea en el `source` de los CloudEvents (`/aerolineas/<código>/vuelos`,
 * contrato v2 §8) si AIRLINE_CODE no dice otro.
 */
export const CODIGO_AEROLINEA_POR_DEFECTO = 'quinde';

/** Formato de AIRLINE_CODE: un segmento de ruta en minúsculas, como el ejemplo del contrato (ecoairlines). */
export const FORMATO_CODIGO_AEROLINEA = /^[a-z0-9][a-z0-9-]{1,39}$/;
