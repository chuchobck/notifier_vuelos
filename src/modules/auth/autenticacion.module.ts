import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { Reloj } from '../../common/reloj';
import { configuracionExterna } from '../../config/autenticacion';
import { ClavesJwks } from './seguridad/claves-jwks';
import { VerificadorJwks } from './seguridad/verificador-jwks';
import { VerificadorToken } from './seguridad/verificador-token';

/** El verificador de los tokens de identity_vuelos, con una línea al arrancar. */
function crearVerificador(config: ConfigService, reloj: Reloj): VerificadorToken {
  const externa = configuracionExterna(config);
  new Logger('Autenticacion').log(
    `Tokens RS256 de ${externa.emisor} (aud ${externa.audiencia}), claves de ${externa.urlJwks}`,
  );
  return new VerificadorJwks(new ClavesJwks(externa.urlJwks, reloj), externa, reloj);
}

/**
 * Autenticación de toda petición: el verificador de tokens y los guards globales. El orden de
 * los APP_GUARD es el de registro:
 *
 *   1. GuardLimitePeticiones (CommonModule, que AppModule importa antes que este módulo)
 *   2. JwtAuthGuard: JWT válido salvo en rutas @Publico()
 *   3. ScopesGuard: los scopes de @Scopes(...) y @SoloClientesOAuth()
 */
@Module({
  providers: [
    { provide: VerificadorToken, inject: [ConfigService, Reloj], useFactory: crearVerificador },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ScopesGuard },
  ],
})
export class AutenticacionModule {}
