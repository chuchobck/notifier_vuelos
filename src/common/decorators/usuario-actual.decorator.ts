import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

/** Quién hace la petición, según el JWT que JwtAuthGuard ya verificó. */
export interface UsuarioAutenticado {
  /** `sub` del token: el `id_propietario` de las suscripciones. */
  id: string;
  scopes: string[];
  /** `jti` del token de acceso. */
  idToken: string;
  /**
   * Solo si el token es de un cliente máquina a máquina (claim `client_id`): el actor es una
   * aplicación, no una persona. `id` sigue siendo el dueño de lo que crea.
   */
  clienteId?: string;
}

export type PeticionAutenticada = Request & { usuario?: UsuarioAutenticado };

/**
 * Inyecta el usuario autenticado en un parámetro del controller:
 *
 *   @Get('me')
 *   perfil(@UsuarioActual() usuario: UsuarioAutenticado) {}
 *
 * En una ruta @Publico() vale undefined.
 */
export const UsuarioActual = createParamDecorator(
  (_dato: unknown, contexto: ExecutionContext): UsuarioAutenticado | undefined =>
    contexto.switchToHttp().getRequest<PeticionAutenticada>().usuario,
);
