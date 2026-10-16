import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ApiProblema } from '../../common/decorators/documentacion.decorator';
import { LimiteEstricto } from '../../common/decorators/limite-peticiones.decorator';
import { Scopes } from '../../common/decorators/scopes.decorator';
import {
  UsuarioActual,
  UsuarioAutenticado,
} from '../../common/decorators/usuario-actual.decorator';
import { UuidPipe } from '../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../config/swagger';
import { SolicitudWebhookDto, WebhookDto } from './dto/webhook.dto';
import { aWebhook } from './suscripcion.mapper';
import { LIMITE_ALTA_WEBHOOK, MAXIMO_SUSCRIPCIONES_ACTIVAS } from './suscripcion.modelo';
import { SuscripcionService } from './suscripcion.service';

const LIMITE_CONSULTAS = 'Se pasó del límite de peticiones por IP';

/**
 * /flights/v1/webhooks: las mismas tres operaciones del contrato (y del core), con el mismo
 * scope, las mismas respuestas y los mismos errores.
 */
@ApiTags(ETIQUETAS.webhooks)
@Controller()
export class SuscripcionController {
  constructor(private readonly servicio: SuscripcionService) {}

  @Scopes('flights:webhooks')
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Listar suscripciones',
    description:
      'Las suscripciones activas del usuario. El secreto va enmascarado (**** y sus últimos 4 caracteres).',
  })
  @ApiOkResponse({ type: [WebhookDto], description: 'Suscripciones activas' })
  @ApiProblema(429, LIMITE_CONSULTAS)
  async listar(@UsuarioActual() usuario: UsuarioAutenticado): Promise<WebhookDto[]> {
    return (await this.servicio.listar(usuario.id)).map(aWebhook);
  }

  @Scopes('flights:webhooks')
  @LimiteEstricto(LIMITE_ALTA_WEBHOOK.limite, LIMITE_ALTA_WEBHOOK.ventanaSegundos)
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Registrar webhook',
    description:
      `A lo sumo ${MAXIMO_SUSCRIPCIONES_ACTIVAS} suscripciones activas por usuario. Cada entrega es un ` +
      'POST con el WebhookPayload y las cabeceras X-Webhook-Event, X-Webhook-Id (eventId), ' +
      'X-Webhook-Timestamp (segundos desde 1970) y X-Webhook-Signature: sha256=<HMAC-SHA256 de ' +
      '"timestamp.cuerpo" con el secreto>. Se reintenta con espera creciente; respuesta 2xx = recibido.',
  })
  @ApiCreatedResponse({ type: WebhookDto, description: 'Webhook registrado (secreto enmascarado)' })
  @ApiProblema(400, 'Cuerpo inválido o URL que no es un destino permitido')
  @ApiProblema(
    409,
    `Ya tiene ${MAXIMO_SUSCRIPCIONES_ACTIVAS} suscripciones activas o esa URL activa`,
  )
  @ApiProblema(429, `Más de ${LIMITE_ALTA_WEBHOOK.limite} altas por IP en un minuto`)
  async crear(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() solicitud: SolicitudWebhookDto,
  ): Promise<WebhookDto> {
    return aWebhook(await this.servicio.crear(solicitud, usuario.id));
  }

  @Scopes('flights:webhooks')
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Eliminar suscripción',
    description:
      'Baja lógica: deja de recibir eventos. Una suscripción ajena o que no está activa es 404.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Eliminado' })
  @ApiProblema(400, 'id no es un uuid')
  @ApiProblema(404, 'La suscripción no existe, no está activa o es de otro usuario')
  @ApiProblema(429, LIMITE_CONSULTAS)
  async eliminar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', UuidPipe) id: string,
  ): Promise<void> {
    await this.servicio.eliminar(id, usuario.id);
  }
}
