import { Module } from '@nestjs/common';
import { EventoModule } from '../evento/evento.module';
import { FabricaAmqp } from './canal-amqp';
import { ConsumidorAmqp } from './consumidor-amqp';
import { FabricaAmqplib } from './fabrica-amqplib';
import { ProcesadorMensajes } from './procesador-mensajes';

/**
 * El consumidor de eventos desde RabbitMQ (fase 4b). Sin rutas. Con RABBITMQ_ENABLED=false no abre
 * ninguna conexión. Reutiliza PublicacionEventos, la misma del controlador de /internal/v1/events.
 */
@Module({
  imports: [EventoModule],
  providers: [
    ConsumidorAmqp,
    ProcesadorMensajes,
    { provide: FabricaAmqp, useClass: FabricaAmqplib },
  ],
  exports: [ConsumidorAmqp],
})
export class ConsumidorModule {}
