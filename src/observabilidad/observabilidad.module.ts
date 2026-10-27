import { Global, Module } from '@nestjs/common';
import { Observabilidad } from './observabilidad';

/** Trazas y métricas del notifier, disponibles en todos los módulos (ver Observabilidad). */
@Global()
@Module({ providers: [Observabilidad], exports: [Observabilidad] })
export class ObservabilidadModule {}
