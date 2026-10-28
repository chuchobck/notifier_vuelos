import { Module } from '@nestjs/common';
import { EventoModule } from '../evento.module';
import { EventoV2Controller } from './evento.v2.controller';
import { FeedEventos } from './evento.v2.service';

/** El feed /api/v2/vuelos/eventos: lee la tabla evento con el traductor de CloudEvents. */
@Module({
  imports: [EventoModule],
  controllers: [EventoV2Controller],
  providers: [FeedEventos],
})
export class EventoV2Module {}
