import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SaludRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Ida y vuelta mínima a la base; lanza si no hay conexión. */
  async consultarBase(): Promise<void> {
    await this.prisma.db.$queryRaw`SELECT 1`;
  }
}
