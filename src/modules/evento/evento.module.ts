import { Module } from '@nestjs/common';
import { RegistroEsquemas } from './contrato/registro-esquemas';
import { EventoController } from './evento.controller';
import { EventoRepository } from './evento.repository';
import { PublicacionEventos } from './evento.service';
import { Traductores } from './traductores/traductores';

/**
 * La API interna de eventos (/internal/v1/events). RegistroEsquemas carga y compila
 * contracts/events al arrancar: con un esquema faltante o mal formado, la app no levanta.
 */
@Module({
  controllers: [EventoController],
  providers: [
    PublicacionEventos,
    EventoRepository,
    Traductores,
    { provide: RegistroEsquemas, useFactory: () => new RegistroEsquemas() },
  ],
  // El feed de v2 lee con el mismo repositorio y el mismo traductor
  exports: [EventoRepository, Traductores],
})
export class EventoModule {}
