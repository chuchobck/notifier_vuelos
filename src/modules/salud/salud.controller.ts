import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SinLimiteDePeticiones } from '../../common/decorators/limite-peticiones.decorator';
import { Publico } from '../../common/decorators/publico.decorator';
import { CONTENT_TYPE_PROBLEMA, ProblemDetails } from '../../common/errores/problem-details';
import { ETIQUETAS } from '../../config/swagger';
import { DisponibilidadRespuestaDto, VidaRespuestaDto } from './dto/salud-respuesta.dto';
import { SaludService } from './salud.service';

/**
 * Públicos y sin límite de peticiones: el orquestador (Docker, Azure) los sondea siempre desde
 * la misma IP y un 429 daría el servicio por caído.
 */
@ApiTags(ETIQUETAS.salud)
@ApiExtraModels(ProblemDetails)
@Publico()
@SinLimiteDePeticiones()
@Controller()
export class SaludController {
  constructor(private readonly servicio: SaludService) {}

  @Get()
  @ApiOperation({
    summary: 'Chequeo de vida: el proceso responde (no mira la base)',
    description: 'Sirve para reiniciar un contenedor colgado; una base caída no lo hace fallar.',
  })
  @ApiOkResponse({ type: VidaRespuestaDto })
  vida(): VidaRespuestaDto {
    return this.servicio.vida();
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Chequeo de disponibilidad: 200 solo si la base contesta',
    description: 'Sirve para sacar la instancia del balanceador mientras la base no responde.',
  })
  @ApiOkResponse({ type: DisponibilidadRespuestaDto })
  @ApiServiceUnavailableResponse({
    description: 'La base no responde',
    content: { [CONTENT_TYPE_PROBLEMA]: { schema: { $ref: getSchemaPath(ProblemDetails) } } },
  })
  async disponibilidad(): Promise<DisponibilidadRespuestaDto> {
    const salud = await this.servicio.disponibilidad();
    if (salud.status === 'DOWN') {
      throw new ServiceUnavailableException('The database is not responding');
    }
    return salud;
  }
}
