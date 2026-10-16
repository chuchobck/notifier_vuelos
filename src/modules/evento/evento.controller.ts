import { Body, Controller, Header, Post, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { ApiProblema } from '../../common/decorators/documentacion.decorator';
import { LimiteEventos } from '../../common/decorators/limite-peticiones.decorator';
import { Scopes, SoloClientesOAuth } from '../../common/decorators/scopes.decorator';
import {
  UsuarioActual,
  UsuarioAutenticado,
} from '../../common/decorators/usuario-actual.decorator';
import { ETIQUETAS } from '../../config/swagger';
import { EventoAceptadoDto, SobreEventoDto } from './dto/evento.dto';
import { aEventoAceptado } from './evento.mapper';
import { PublicacionEventos } from './evento.service';

/** /internal/v1/events: por donde el core publica sus eventos. */
@ApiTags(ETIQUETAS.eventos)
@Controller()
export class EventoController {
  constructor(private readonly servicio: PublicacionEventos) {}

  @Scopes('events:publish')
  @SoloClientesOAuth()
  @LimiteEventos()
  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Publicar un evento',
    description:
      'Solo el core, con un token de cliente OAuth (client_credentials) con events:publish. El ' +
      'sobre se valida contra contracts/events/<tipo>.v<mayor>.json; en una transacción se guarda ' +
      'y se crea una entrega por cada suscripción activa del ownerId que escucha el tipo. ' +
      'Idempotente por eventId. Reglas y data por tipo: docs/EVENTOS.md.',
  })
  @ApiBody({ type: SobreEventoDto })
  @ApiAcceptedResponse({
    type: EventoAceptadoDto,
    description: 'Primera vez: el evento y sus entregas ya están guardados (después del commit)',
  })
  @ApiOkResponse({
    type: EventoAceptadoDto,
    description: 'El eventId ya se había publicado con el mismo contenido: no se duplicó nada',
  })
  @ApiProblema(400, 'El sobre no cumple el esquema de su tipo y versión')
  @ApiProblema(409, 'El eventId ya se había publicado con otro contenido')
  @ApiProblema(422, 'eventType o schemaVersion desconocidos')
  @ApiProblema(429, 'Más de EVENTS_RATE_LIMIT_MAX publicaciones por minuto desde la misma IP')
  async publicar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() cuerpo: Record<string, unknown>,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<EventoAceptadoDto> {
    // @SoloClientesOAuth garantiza que hay client_id
    const resultado = await this.servicio.publicar(cuerpo, usuario.clienteId as string);
    respuesta.status(resultado.duplicado ? 200 : 202);
    return aEventoAceptado(resultado);
  }
}
