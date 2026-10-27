import type { Request } from 'express';

/** Ruta que no corresponde a ninguna plantilla (404, un preflight, archivos estáticos). */
export const SIN_PLANTILLA = '__unmatched__';

/**
 * La plantilla de la ruta que atendió la petición: `/flights/v1/bookings/{bookingId}`, nunca la
 * pedida. La ruta de Express trae `:bookingId`; el estándar escribe `{bookingId}`. Sin ruta
 * (404, archivos estáticos, un preflight), undefined: `__unmatched__`. Es lo que van en el nombre
 * del span, en la etiqueta `route` de las métricas y en las líneas de log: ni ids de reserva, ni
 * correos, ni nada que venga en la URL.
 */
export function plantillaDeRuta(peticion: Request): string | undefined {
  const ruta = (peticion.route as { path?: unknown } | undefined)?.path;
  return typeof ruta === 'string' ? ruta.replace(/:([A-Za-z0-9_]+)\??/g, '{$1}') : undefined;
}
