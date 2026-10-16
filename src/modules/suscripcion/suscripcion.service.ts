import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CODIGO_SIN_EQUIVALENTE, CodigoError } from '../../common/errores/codigo-error';
import { ErrorNegocio } from '../../common/errores/error-negocio';
import { Reloj } from '../../common/reloj';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditoriaSuscripciones } from '../auditoria/auditoria.service';
import { CifradoSecreto } from '../compartido/cifrado-secreto';
import { motivoDestinoInvalido } from '../compartido/destino-permitido';
import { enmascarar, porOrdenDelContrato } from '../compartido/eventos-webhook';
import { SolicitudWebhookDto } from './dto/webhook.dto';
import { MAXIMO_SUSCRIPCIONES_ACTIVAS, SuscripcionVista } from './suscripcion.modelo';
import { SuscripcionRepository } from './suscripcion.repository';

/**
 * Suscripciones a webhooks del usuario del token (GET, POST y DELETE /webhooks), con las mismas
 * reglas del core: todo es del dueño (una suscripción ajena es 404), a lo sumo 10 activas, una
 * URL activa no se repite, y el destino se valida contra SSRF. Alta y baja van en una
 * transacción con su registro de auditoría (sin el secreto ni la URL completa).
 */
@Injectable()
export class SuscripcionService {
  private readonly produccion: boolean;

  constructor(
    private readonly repositorio: SuscripcionRepository,
    private readonly cifrado: CifradoSecreto,
    private readonly auditoria: AuditoriaSuscripciones,
    private readonly prisma: PrismaService,
    private readonly reloj: Reloj,
    config: ConfigService,
  ) {
    this.produccion = config.get<string>('NODE_ENV') === 'production';
  }

  /**
   * Registra la suscripción. 400 si la URL no es un destino válido (https en producción, y que
   * no resuelva a una red interna); 409 si el usuario ya tiene 10 activas o ya tiene esa URL.
   */
  async crear(solicitud: SolicitudWebhookDto, idPropietario: string): Promise<SuscripcionVista> {
    const motivo = await motivoDestinoInvalido(solicitud.url, { produccion: this.produccion });
    // La URL no se repite en el error: puede llevar un token en la consulta
    if (motivo !== null) {
      throw new ErrorNegocio(400, CodigoError.VALIDATION_FAILED, `url: ${motivo}`, {
        invalidParams: [{ name: 'url', reason: motivo }],
      });
    }

    const eventos = [...solicitud.events].sort(porOrdenDelContrato);
    const ahora = this.reloj.ahora();
    const id = await this.prisma.transaccion(async (tx) => {
      if (
        (await this.repositorio.contarActivasBloqueando(tx, idPropietario)) >=
        MAXIMO_SUSCRIPCIONES_ACTIVAS
      ) {
        throw new ErrorNegocio(
          409,
          CODIGO_SIN_EQUIVALENTE,
          `At most ${MAXIMO_SUSCRIPCIONES_ACTIVAS} active webhooks per user; delete one first`,
        );
      }
      // Con el candado del dueño tomado, nadie más le agrega una: se pregunta antes de insertar
      // para que el índice único no salte (PostgreSQL dejaría la URL en su propio log). El índice
      // sigue ahí como última barrera, con el mismo 409.
      if (await this.repositorio.tieneUrlActiva(tx, idPropietario, solicitud.url)) {
        throw new ErrorNegocio(
          409,
          CODIGO_SIN_EQUIVALENTE,
          'A webhook with this URL already exists',
        );
      }
      const creada = await this.repositorio.crear(tx, {
        idPropietario,
        url: solicitud.url,
        secretoCifrado: this.cifrado.cifrar(solicitud.secret),
        eventos,
        fecha: ahora,
      });
      await this.auditoria.registrar(
        tx,
        {
          accion: 'SUSCRIPCION_CREADA',
          suscripcionId: creada,
          idPropietario,
          url: solicitud.url,
          eventos,
        },
        ahora,
      );
      return creada;
    });
    return { id, url: solicitud.url, eventos, secretoEnmascarado: enmascarar(solicitud.secret) };
  }

  async listar(idPropietario: string): Promise<SuscripcionVista[]> {
    const suscripciones = await this.repositorio.activasDe(idPropietario);
    return suscripciones.map((s) => ({
      id: s.id,
      url: s.url,
      eventos: s.eventos,
      secretoEnmascarado: this.enmascarado(s.secretoCifrado),
    }));
  }

  /** Baja lógica: 404 si no existe, no está activa o es de otro usuario. */
  async eliminar(id: string, idPropietario: string): Promise<void> {
    const ahora = this.reloj.ahora();
    const existia = await this.prisma.transaccion(async (tx) => {
      const baja = await this.repositorio.desactivar(tx, id, idPropietario, ahora);
      if (baja === null) return false;
      await this.auditoria.registrar(
        tx,
        {
          accion: 'SUSCRIPCION_ELIMINADA',
          suscripcionId: id,
          idPropietario,
          url: baja.url,
          eventos: baja.eventos,
        },
        ahora,
      );
      return true;
    });
    if (!existia) {
      throw new ErrorNegocio(404, CODIGO_SIN_EQUIVALENTE, `Webhook ${id} was not found`);
    }
  }

  /** El secreto enmascarado; si no se puede descifrar (la clave cambió), solo `****`. */
  private enmascarado(secretoCifrado: string): string {
    try {
      return enmascarar(this.cifrado.descifrar(secretoCifrado));
    } catch {
      return '****';
    }
  }
}
