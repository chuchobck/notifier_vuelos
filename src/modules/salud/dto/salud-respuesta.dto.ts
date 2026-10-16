import { ApiProperty } from '@nestjs/swagger';

export type EstadoComponente = 'UP' | 'DOWN';

/** GET /health: el proceso responde. No mira la base. */
export class VidaRespuestaDto {
  @ApiProperty({ enum: ['UP'], description: 'El proceso está vivo' })
  status!: 'UP';

  @ApiProperty({ example: '2026-10-15T19:00:00.000Z', description: 'Hora del servidor (UTC)' })
  timestamp!: string;
}

/** GET /health/ready: el servicio puede atender (la base contesta). */
export class DisponibilidadRespuestaDto {
  @ApiProperty({ enum: ['UP', 'DOWN'], description: 'Estado general del servicio' })
  status!: EstadoComponente;

  @ApiProperty({ enum: ['UP', 'DOWN'], description: 'Resultado de SELECT 1 contra PostgreSQL' })
  database!: EstadoComponente;

  @ApiProperty({ example: '2026-10-15T19:00:00.000Z', description: 'Hora del servidor (UTC)' })
  timestamp!: string;
}
