import { Routes } from '@nestjs/core';
import { saludRoutes } from '../modules/salud/salud.routes';
import { suscripcionRoutes } from '../modules/suscripcion/suscripcion.routes';

/**
 * Única tabla de rutas del servicio. Junta los *.routes.ts de cada módulo; los controllers
 * no llevan prefijo propio. Cada grupo lleva su versión en la ruta:
 *
 *   /health, /health/ready        salud (sin versión: la sondea el orquestador)
 *   /flights/v1/webhooks          suscripciones, la misma ruta que en el core (contrato 1.5.0.0)
 */
export const rutas: Routes = [...saludRoutes, ...suscripcionRoutes];

/**
 * Rutas cuyas respuestas no se guardan en ninguna caché: llevan la URL de un tercero o son de
 * la API interna.
 */
export const RUTAS_SIN_CACHE: string[] = ['/flights/v1/webhooks'];
