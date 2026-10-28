import { Routes } from '@nestjs/core';
import { SuscripcionV2Module } from './suscripcion.v2.module';

/** La ruta del contrato de Vuelos v2 (MS.Clientes): /api/v2/vuelos/webhooks. */
export const suscripcionV2Routes: Routes = [
  { path: 'api/v2/vuelos/webhooks', module: SuscripcionV2Module },
];
