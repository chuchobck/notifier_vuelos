import { Routes } from '@nestjs/core';
import { SuscripcionModule } from './suscripcion.module';

/** La misma ruta que en el core: /flights/v1/webhooks. */
export const suscripcionRoutes: Routes = [
  { path: 'flights/v1/webhooks', module: SuscripcionModule },
];
