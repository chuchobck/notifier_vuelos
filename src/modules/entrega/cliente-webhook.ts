/** Lo que se le manda a la URL de una suscripción. */
export interface PeticionWebhook {
  url: string;
  cabeceras: Record<string, string>;
  cuerpo: string;
}

/**
 * Cómo salió el envío. `codigoHttp` es el de la respuesta (null si no hubo). `error` es un
 * código corto y estable (TIMEOUT, ECONNREFUSED, DESTINATION_NOT_ALLOWED...), nunca la URL, el
 * cuerpo ni el mensaje de la librería: pueden traer datos del suscriptor.
 */
export interface ResultadoWebhook {
  codigoHttp: number | null;
  error: string | null;
}

/**
 * El HTTP de las entregas, detrás de una interfaz: las pruebas la reemplazan por un doble para
 * simular un receptor caído, lento o que responde 500. Es una clase abstracta para poder usarla
 * como token de inyección.
 */
export abstract class ClienteWebhook {
  abstract enviar(peticion: PeticionWebhook): Promise<ResultadoWebhook>;
}
