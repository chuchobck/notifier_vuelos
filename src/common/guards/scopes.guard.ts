import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CODIGO_SIN_EQUIVALENTE } from '../errores/codigo-error';
import { ErrorNegocio } from '../errores/error-negocio';
import { SCOPES_REQUERIDOS, SOLO_CLIENTES } from '../decorators/scopes.decorator';
import { PeticionAutenticada } from '../decorators/usuario-actual.decorator';
import { desafioBearer } from '../../modules/auth/errores-auth';

const SOLO_CLIENTES_DETALLE = 'This operation requires an OAuth client token (client_credentials)';

/**
 * Guard global, el último: si la ruta lleva @Scopes(...), el token debe traerlos todos.
 * Si falta alguno responde 403 diciendo cuáles (RFC 6750: `error="insufficient_scope"`).
 * Si además lleva @SoloClientesOAuth(), el token tiene que ser de un cliente (traer
 * `client_id`): el de una persona es 403 aunque traiga los scopes.
 */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(contexto: ExecutionContext): boolean {
    const objetivos = [contexto.getHandler(), contexto.getClass()];
    const requeridos = this.reflector.getAllAndOverride<string[] | undefined>(
      SCOPES_REQUERIDOS,
      objetivos,
    );
    const soloClientes = this.reflector.getAllAndOverride<boolean>(SOLO_CLIENTES, objetivos);
    if ((!requeridos || requeridos.length === 0) && !soloClientes) return true;

    // Sin usuario solo se llega si la ruta es @Publico() y además pide scopes: se niega.
    const usuario = contexto.switchToHttp().getRequest<PeticionAutenticada>().usuario;
    const faltantes = (requeridos ?? []).filter((scope) => !usuario?.scopes.includes(scope));
    if (faltantes.length > 0) {
      const detalle = `Missing required scopes: ${faltantes.join(' ')}`;
      throw new ErrorNegocio(403, CODIGO_SIN_EQUIVALENTE, detalle, {
        cabeceras: {
          'WWW-Authenticate': desafioBearer('insufficient_scope', detalle, requeridos),
        },
      });
    }

    if (soloClientes && usuario?.clienteId === undefined) {
      throw new ErrorNegocio(403, CODIGO_SIN_EQUIVALENTE, SOLO_CLIENTES_DETALLE, {
        cabeceras: {
          'WWW-Authenticate': desafioBearer(
            'insufficient_scope',
            SOLO_CLIENTES_DETALLE,
            requeridos,
          ),
        },
      });
    }
    return true;
  }
}
