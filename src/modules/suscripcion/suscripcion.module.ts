import { Module } from '@nestjs/common';
import { CifradoSecreto } from '../compartido/cifrado-secreto';
import { SuscripcionController } from './suscripcion.controller';
import { SuscripcionRepository } from './suscripcion.repository';
import { SuscripcionService } from './suscripcion.service';

/**
 * Suscripciones a webhooks (/flights/v1/webhooks del contrato). suscripcion_evento no tiene
 * controller: lo maneja este service.
 */
@Module({
  controllers: [SuscripcionController],
  providers: [SuscripcionService, SuscripcionRepository, CifradoSecreto],
})
export class SuscripcionModule {}
