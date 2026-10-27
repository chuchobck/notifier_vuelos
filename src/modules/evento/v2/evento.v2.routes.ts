import { Routes } from '@nestjs/core';
import { EventoV2Module } from './evento.v2.module';

/** La ruta del contrato de Vuelos v2 (MS.Vuelos, telemetría): /api/v2/vuelos/eventos. */
export const eventoV2Routes: Routes = [{ path: 'api/v2/vuelos/eventos', module: EventoV2Module }];
