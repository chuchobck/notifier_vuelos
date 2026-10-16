import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerLimitDetail } from '@nestjs/throttler/dist/throttler.guard.interface';
import { CodigoError } from '../errores/codigo-error';
import { ErrorNegocio } from '../errores/error-negocio';

/**
 * Guard global del límite de peticiones. Al pasarse del límite responde 429
 * RATE_LIMIT_EXCEEDED como ProblemDetails, con `Retry-After` en segundos.
 *
 * Cuenta por `req.ip`: detrás de un proxy (un balanceador) solo es la IP del cliente si Express tiene
 * `trust proxy` configurado (ver TRUST_PROXY).
 */
@Injectable()
export class GuardLimitePeticiones extends ThrottlerGuard {
  protected override async throwThrottlingException(
    _contexto: ExecutionContext,
    detalle: ThrottlerLimitDetail,
  ): Promise<void> {
    const segundos = Math.max(1, Math.ceil(detalle.timeToBlockExpire || detalle.ttl / 1000));
    throw new ErrorNegocio(
      429,
      CodigoError.RATE_LIMIT_EXCEEDED,
      `Too many requests; retry in ${segundos} seconds`,
      { cabeceras: { 'Retry-After': String(segundos) } },
    );
  }
}
