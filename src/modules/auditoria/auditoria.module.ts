import { Global, Module } from '@nestjs/common';
import { AuditoriaRepository } from './auditoria.repository';
import { AuditoriaSuscripciones } from './auditoria.service';

/** Global: las suscripciones, la entrega (baja automática) y la importación auditan. */
@Global()
@Module({
  providers: [AuditoriaSuscripciones, AuditoriaRepository],
  exports: [AuditoriaSuscripciones],
})
export class AuditoriaModule {}
