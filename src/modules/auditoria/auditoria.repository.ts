import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { TransaccionNotificaciones } from '../../prisma/prisma.service';

/** Único punto del módulo que usa Prisma. La tabla es de solo inserción (un trigger lo impone). */
@Injectable()
export class AuditoriaRepository {
  async insertar(
    tx: TransaccionNotificaciones,
    fila: Prisma.auditoriaUncheckedCreateInput,
  ): Promise<void> {
    await tx.auditoria.create({ data: fila, select: { id: true } });
  }
}
