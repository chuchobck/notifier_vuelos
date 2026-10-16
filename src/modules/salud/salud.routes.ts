import { Routes } from '@nestjs/core';
import { SaludModule } from './salud.module';

export const saludRoutes: Routes = [{ path: 'health', module: SaludModule }];
