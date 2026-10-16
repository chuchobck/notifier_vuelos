/**
 * `CORS_ORIGINS`: lista de orígenes (esquema, host y puerto) separados por coma que pueden
 * llamar al servicio desde un navegador. Vacía o ausente: ninguno (el servicio solo lo usan
 * servidores y herramientas, que no pasan por CORS).
 *
 *   CORS_ORIGINS=https://quinde.example.com,http://localhost:5173
 */

/** `https://app.example.com`: sin ruta, sin barra final y sin comodín. */
export function esOrigenValido(origen: string): boolean {
  try {
    const url = new URL(origen);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origen;
  } catch {
    return false;
  }
}

/** Separa por comas y descarta los vacíos; no valida (eso lo hace `esOrigenValido`). */
export function listarOrigenes(valor: string | undefined): string[] {
  return (valor ?? '')
    .split(',')
    .map((origen) => origen.trim())
    .filter((origen) => origen !== '');
}
