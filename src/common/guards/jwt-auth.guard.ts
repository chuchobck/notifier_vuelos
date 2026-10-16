import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fijarUsuario } from '../contexto/contexto-peticion';
import { ES_PUBLICO } from '../decorators/publico.decorator';
import { PeticionAutenticada } from '../decorators/usuario-actual.decorator';
import { CodigoError } from '../errores/codigo-error';
import { ErrorNegocio } from '../errores/error-negocio';
import { desafioBearer, noAutenticado } from '../../modules/auth/errores-auth';
import { JwksNoDisponibleError } from '../../modules/auth/seguridad/claves-jwks';
import {
  TokenInvalidoError,
  VerificadorToken,
} from '../../modules/auth/seguridad/verificador-token';

/** `Bearer <token>`; el esquema no distingue mayúsculas (RFC 7235). */
const CABECERA_BEARER = /^Bearer[ ]+([A-Za-z0-9._~+/-]+=*)[ ]*$/i;

/**
 * Guard global: toda ruta exige un JWT de acceso válido salvo las marcadas con @Publico().
 * Corre después del límite de peticiones (un 401 también cuenta) y antes de ScopesGuard.
 *
 * - Sin cabecera Authorization, o con otro esquema: 401 con `WWW-Authenticate: Bearer realm=...`
 * - Token vencido, mal firmado, de otro emisor o audiencia: 401 con `error="invalid_token"`
 * - Sin claves del servicio de identidad con que verificar (caído y sin copia vigente del
 *   JWKS): 503 AUTH_UNAVAILABLE con Retry-After. Nunca 401 ni deja pasar.
 *
 * Con un token válido deja el usuario en la petición (@UsuarioActual) y en el contexto, para
 * que la auditoría registre su `sub`. El token nunca va al log ni a la respuesta.
 *
 * El guard depende solo de VerificadorToken (AutenticacionModule); es asíncrono porque la
 * verificación puede necesitar la red.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verificador: VerificadorToken,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const esPublico = this.reflector.getAllAndOverride<boolean>(ES_PUBLICO, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);
    if (esPublico) return true;

    const peticion = contexto.switchToHttp().getRequest<PeticionAutenticada>();
    const coincidencia = CABECERA_BEARER.exec(peticion.headers.authorization ?? '');
    if (!coincidencia) throw noAutenticado('A bearer access token is required');

    try {
      const identidad = await this.verificador.verificar(coincidencia[1]);
      peticion.usuario = {
        id: identidad.sub,
        scopes: identidad.scopes,
        idToken: identidad.jti,
        ...(identidad.clienteId === undefined ? {} : { clienteId: identidad.clienteId }),
      };
      fijarUsuario(identidad.sub, identidad.clienteId);
      return true;
    } catch (error) {
      if (error instanceof JwksNoDisponibleError) throw servicioNoDisponible(error);
      if (!(error instanceof TokenInvalidoError)) throw error;
      throw noAutenticado(error.message, desafioBearer('invalid_token', error.message));
    }
  }
}

/** 503 AUTH_UNAVAILABLE: no es culpa del cliente; que reintente cuando lo diga Retry-After. */
function servicioNoDisponible(error: JwksNoDisponibleError): ErrorNegocio {
  return new ErrorNegocio(
    503,
    CodigoError.AUTH_UNAVAILABLE,
    'The identity service is not available to verify the access token; retry later',
    { cabeceras: { 'Retry-After': String(error.reintentarEnSegundos) }, causa: error },
  );
}
