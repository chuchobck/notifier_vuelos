import { Injectable, Logger } from '@nestjs/common';
import { Reloj } from '../../common/reloj';
import { resumirError } from '../../prisma/prisma.service';
import { DisponibilidadRespuestaDto, VidaRespuestaDto } from './dto/salud-respuesta.dto';
import { SaludRepository } from './salud.repository';

@Injectable()
export class SaludService {
  private readonly logger = new Logger(SaludService.name);

  constructor(
    private readonly repositorio: SaludRepository,
    private readonly reloj: Reloj,
  ) {}

  vida(): VidaRespuestaDto {
    return { status: 'UP', timestamp: this.reloj.ahora().toISOString() };
  }

  async disponibilidad(): Promise<DisponibilidadRespuestaDto> {
    let baseDisponible = true;
    try {
      await this.repositorio.consultarBase();
    } catch (error) {
      baseDisponible = false;
      this.logger.error(`La base no responde: ${resumirError(error)}`);
    }
    const estado = baseDisponible ? 'UP' : 'DOWN';
    return { status: estado, database: estado, timestamp: this.reloj.ahora().toISOString() };
  }
}
