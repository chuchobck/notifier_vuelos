import { Module } from '@nestjs/common';
import { SuscripcionModule } from '../suscripcion.module';
import { SuscripcionV2Controller } from './suscripcion.v2.controller';

/** /api/v2/vuelos/webhooks: el mismo SuscripcionService de v1, con el formato v2. */
@Module({
  imports: [SuscripcionModule],
  controllers: [SuscripcionV2Controller],
})
export class SuscripcionV2Module {}
