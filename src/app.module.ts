import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RouterModule } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { validarEntorno } from './config/entorno';
import { AuditoriaModule } from './modules/auditoria/auditoria.module';
import { AutenticacionModule } from './modules/auth/autenticacion.module';
import { EventoModule } from './modules/evento/evento.module';
import { SaludModule } from './modules/salud/salud.module';
import { SuscripcionModule } from './modules/suscripcion/suscripcion.module';
import { PrismaModule } from './prisma/prisma.module';
import { rutas } from './routes/index.routes';

@Module({
  imports: [
    // Carga las variables de entorno y las valida; si falta una, el servicio no levanta
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validarEntorno,
    }),

    // CommonModule va primero: el límite de peticiones es el primer guard global, antes que
    // los de AutenticacionModule (token y scopes).
    PrismaModule,
    CommonModule,
    AutenticacionModule,
    SaludModule,
    AuditoriaModule,
    SuscripcionModule,
    EventoModule,

    // Tabla de rutas: src/routes/index.routes.ts
    RouterModule.register(rutas),
  ],
})
export class AppModule {}
