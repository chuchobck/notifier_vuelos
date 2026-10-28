import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemaV2 } from '../../../common/decorators/documentacion.decorator';
import { ScopesV2 } from '../../../common/decorators/scopes.decorator';
import {
  UsuarioActual,
  UsuarioAutenticado,
} from '../../../common/decorators/usuario-actual.decorator';
import { ETIQUETAS } from '../../../config/swagger';
import { ConsultaFeedDto, FeedEventosDto, LIMITE_FEED } from './dto/feed.v2.dto';
import { FeedEventos } from './evento.v2.service';

/** /api/v2/vuelos/eventos: el feed de eventos del contrato de Vuelos v2 (respaldo de los webhooks). */
@ApiTags(ETIQUETAS.feedV2)
@Controller()
export class EventoV2Controller {
  constructor(private readonly feed: FeedEventos) {}

  @ScopesV2('flights:read')
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'X-Correlation-Id',
    required: false,
    description: 'Id del proceso de negocio; se devuelve sin cambios (si falta, se genera)',
  })
  @ApiOperation({
    operationId: 'listOutboxEvents',
    summary: 'Feed de eventos CloudEvents (respaldo de los webhooks)',
    description:
      'Los eventos del dueño del token en orden de llegada, como CloudEvents (los mismos de la ' +
      `entrega v2). Paginación por cursor: \`after\` = el id del último leído; \`limit\` de ` +
      `${LIMITE_FEED.minimo} a ${LIMITE_FEED.maximo} (${LIMITE_FEED.porDefecto} por defecto). ` +
      'Un `after` desconocido o de otro dueño es 400.',
  })
  @ApiOkResponse({ type: FeedEventosDto, description: 'Página de eventos' })
  @ApiProblemaV2(400, 'limit, after o type inválidos (VALIDATION_FAILED)')
  @ApiProblemaV2(429, 'Se pasó del límite de peticiones por IP (RATE_LIMIT_EXCEEDED)')
  async listar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Query() consulta: ConsultaFeedDto,
  ): Promise<FeedEventosDto> {
    const pagina = await this.feed.pagina(usuario.id, {
      limite: consulta.limit ?? LIMITE_FEED.porDefecto,
      despuesDe: consulta.after,
      tipo: consulta.type,
    });
    return {
      events: pagina.eventos,
      metadata: {
        total: pagina.eventos.length,
        next_after: pagina.siguiente,
        timestamp: new Date().toISOString(),
      },
    };
  }
}
