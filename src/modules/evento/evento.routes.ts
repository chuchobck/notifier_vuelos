import { Routes } from '@nestjs/core';
import { EventoModule } from './evento.module';

export const eventoRoutes: Routes = [{ path: 'internal/v1/events', module: EventoModule }];
