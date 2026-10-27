import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ApiProblemaV2 } from '../../../common/decorators/documentacion.decorator';
import { LimiteEstricto } from '../../../common/decorators/limite-peticiones.decorator';
import { ScopesV2 } from '../../../common/decorators/scopes.decorator';
import {
  UsuarioActual,
  UsuarioAutenticado,
} from '../../../common/decorators/usuario-actual.decorator';
import { UuidPipe } from '../../../common/pipes/uuid.pipe';
import { ETIQUETAS } from '../../../config/swagger';
import { LIMITE_ALTA_WEBHOOK, MAXIMO_SUSCRIPCIONES_ACTIVAS } from '../suscripcion.modelo';
import { SuscripcionService } from '../suscripcion.service';
import { SolicitudWebhookV2Dto, WebhookV2Dto } from './dto/webhook.v2.dto';
import { aWebhookV2 } from './suscripcion.v2.mapper';

const LIMITE_CONSULTAS = 'Se pasó del límite de peticiones por IP (RATE_LIMIT_EXCEEDED)';

const CORRELACION = {
  name: 'X-Correlation-Id',
  required: false,
  description:
    'Id del proceso de negocio (máx. 100, [A-Za-z0-9._:-]). Se devuelve sin cambios; si falta, se genera',
};

/**
 * /api/v2/vuelos/webhooks (MS.Clientes del contrato de Vuelos v2): listWebhooks, createWebhook y
 * deleteWebhook, con las mismas reglas que /flights/v1/webhooks (scope, 10 activas, 409 por URL
 * repetida, SSRF, secreto cifrado y enmascarado, 404 si es ajena) y los 15 VuelosEventName. Lo
 * que la diferencia es la entrega: CloudEvents 1.0 en vez del WebhookPayload v1. Los errores
 * salen con el ProblemDetails de v2.
 */
@ApiTags(ETIQUETAS.webhooksV2)
@ApiHeader(CORRELACION)
@Controller()
export class SuscripcionV2Controller {
  constructor(private readonly servicio: SuscripcionService) {}

  @ScopesV2('flights:webhooks')
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'listWebhooks',
    summary: 'Listar suscripciones de webhooks del partner',
    description:
      'Las suscripciones v2 activas del dueño del token (las de /flights/v1/webhooks no aparecen). ' +
      'El secreto va enmascarado.',
  })
  @ApiOkResponse({ type: [WebhookV2Dto], description: 'Suscripciones activas' })
  @ApiProblemaV2(429, LIMITE_CONSULTAS)
  async listar(@UsuarioActual() usuario: UsuarioAutenticado): Promise<WebhookV2Dto[]> {
    return (await this.servicio.listar(usuario.id, 'v2')).map(aWebhookV2);
  }

  @ScopesV2('flights:webhooks')
  @LimiteEstricto(LIMITE_ALTA_WEBHOOK.limite, LIMITE_ALTA_WEBHOOK.ventanaSegundos)
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Opcional y sin efecto: la operación ya es idempotente por construcción (la misma URL ' +
      'activa del mismo dueño es 409)',
  })
  @ApiOperation({
    operationId: 'createWebhook',
    summary: 'Registrar un webhook para recibir eventos CloudEvents',
    description:
      `A lo sumo ${MAXIMO_SUSCRIPCIONES_ACTIVAS} suscripciones activas por dueño (sumando v1 y v2). ` +
      'Cada entrega es un POST application/cloudevents+json (modo estructurado) con ' +
      'X-Webhook-Signature: sha256=<HMAC-SHA256 en hex del cuerpo con el secreto> y ' +
      'X-Correlation-Id. Reintentos a 1, 5, 30, 120 y 360 minutos hasta un 2xx; lo que no llegue ' +
      'sigue en GET /api/v2/vuelos/eventos.',
  })
  @ApiCreatedResponse({
    type: WebhookV2Dto,
    description: 'Webhook registrado (secreto enmascarado)',
  })
  @ApiProblemaV2(400, 'Cuerpo inválido o URL que no es un destino permitido (VALIDATION_FAILED)')
  @ApiProblemaV2(
    409,
    `Ya tiene ${MAXIMO_SUSCRIPCIONES_ACTIVAS} suscripciones activas o esa URL activa (VALIDATION_FAILED)`,
  )
  @ApiProblemaV2(429, `Más de ${LIMITE_ALTA_WEBHOOK.limite} altas por IP en un minuto`)
  async crear(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() solicitud: SolicitudWebhookV2Dto,
  ): Promise<WebhookV2Dto> {
    return aWebhookV2(await this.servicio.crear(solicitud, usuario.id, 'v2'));
  }

  @ScopesV2('flights:webhooks')
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    operationId: 'deleteWebhook',
    summary: 'Eliminar una suscripción',
    description:
      'Baja lógica: deja de recibir eventos. Una suscripción ajena, inactiva o creada por ' +
      '/flights/v1/webhooks es 404.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Eliminada' })
  @ApiProblemaV2(400, 'id no es un uuid')
  @ApiProblemaV2(404, 'La suscripción no existe, no está activa o es de otro dueño (NOT_FOUND)')
  @ApiProblemaV2(429, LIMITE_CONSULTAS)
  async eliminar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', UuidPipe) id: string,
  ): Promise<void> {
    await this.servicio.eliminar(id, usuario.id, 'v2');
  }
}
