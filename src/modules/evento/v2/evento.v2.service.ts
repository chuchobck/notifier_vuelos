import { Injectable } from '@nestjs/common';
import { CODIGO_SIN_EQUIVALENTE } from '../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../common/errores/error-negocio';
import { TipoEvento } from '../../compartido/eventos-webhook';
import { EventoRepository } from '../evento.repository';
import { CloudEvent } from '../traductores/cloudevent.v2';
import { Traductores } from '../traductores/traductores';

export interface PaginaFeed {
  eventos: CloudEvent[];
  /** El id del último evento de la página, o null si vino vacía. */
  siguiente: string | null;
}

/**
 * El feed GET /api/v2/vuelos/eventos (listOutboxEvents): los eventos del DUEÑO DEL TOKEN, como
 * CloudEvents (el mismo traductor de la entrega v2), en orden de llegada y por cursor. Es el
 * respaldo de los webhooks: Booking reconcilia aquí lo que no le llegó. Nunca un evento de otro
 * dueño, ni siquiera al resolver el cursor.
 */
@Injectable()
export class FeedEventos {
  constructor(
    private readonly repositorio: EventoRepository,
    private readonly traductores: Traductores,
  ) {}

  async pagina(
    idPropietario: string,
    consulta: { limite: number; despuesDe?: string; tipo?: TipoEvento },
  ): Promise<PaginaFeed> {
    let desde: bigint | null = null;
    if (consulta.despuesDe !== undefined) {
      desde = await this.repositorio.posicionEnFeed(idPropietario, consulta.despuesDe);
      // Un id que no existe y uno de otro dueño responden igual: no se revela cuál es
      if (desde === null) {
        throw new ErrorNegocio(400, CODIGO_SIN_EQUIVALENTE, 'after: unknown event', {
          invalidParams: [{ name: 'after', reason: 'is not an event of this owner' }],
        });
      }
    }
    const filas = await this.repositorio.feed(idPropietario, {
      desde,
      tipo: consulta.tipo ?? null,
      limite: consulta.limite,
    });
    const eventos = filas.map((fila) => this.traductores.v2(fila));
    return { eventos, siguiente: eventos.at(-1)?.id ?? null };
  }
}
