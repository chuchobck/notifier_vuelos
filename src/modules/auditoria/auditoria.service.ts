import { Injectable } from '@nestjs/common';
import { obtenerContexto } from '../../common/contexto/contexto-peticion';
import { esRequestIdValido } from '../../common/contexto/request-id';
import { accion_auditoria } from '../../generated/prisma/client';
import { TransaccionNotificaciones } from '../../prisma/prisma.service';
import { AuditoriaRepository } from './auditoria.repository';

/** Por qué pasó una baja o una importación. Lista cerrada: nunca texto libre. */
export type MotivoAuditoria = 'FALLIDAS_SEGUIDAS' | 'IMPORTADA_INACTIVA';

export interface RegistroAuditoria {
  accion: accion_auditoria;
  suscripcionId: string;
  idPropietario: string;
  /** La URL de la suscripción: de ella se guarda solo el host (y el puerto). */
  url: string;
  eventos: readonly string[];
  motivo?: MotivoAuditoria;
}

/**
 * Deja cada alta y baja de una suscripción en `auditoria`, DENTRO de la transacción que la
 * cambia: si el cambio se deshace, su registro también. Lleva quién actuó (el `sub` del token;
 * nadie en un proceso interno), la IP y el X-Request-Id de la petición, los eventos y el host del
 * destino. Nunca el secreto (ni cifrado) ni la URL completa: su ruta o su query pueden llevar un
 * token del tercero.
 */
@Injectable()
export class AuditoriaSuscripciones {
  constructor(private readonly repositorio: AuditoriaRepository) {}

  async registrar(
    tx: TransaccionNotificaciones,
    registro: RegistroAuditoria,
    fecha: Date,
  ): Promise<void> {
    const contexto = obtenerContexto();
    await this.repositorio.insertar(tx, {
      fecha,
      accion: registro.accion,
      suscripcion_id: registro.suscripcionId,
      id_propietario: registro.idPropietario,
      actor: contexto?.usuario ?? null,
      host_destino: hostDe(registro.url),
      eventos: [...registro.eventos],
      motivo: registro.motivo ?? null,
      direccion_ip: contexto?.ip ?? null,
      id_peticion: contexto && esRequestIdValido(contexto.requestId) ? contexto.requestId : null,
    });
  }
}

/** `https://hooks.example.com:8443/ruta?token=x` → `hooks.example.com:8443`. */
export function hostDe(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}
