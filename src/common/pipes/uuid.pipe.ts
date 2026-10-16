import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { CodigoError } from '../errores/codigo-error';
import { ErrorNegocio } from '../errores/error-negocio';

export function esUuid(valor: unknown): valor is string {
  return typeof valor === 'string' && isUUID(valor);
}

/**
 * Exige un UUID en un parámetro de ruta; si no, 400 VALIDATION_FAILED nombrando el parámetro
 * (como UuidPipe del core).
 *
 *   @Delete(':id')
 *   eliminar(@Param('id', UuidPipe) id: string) {}
 */
@Injectable()
export class UuidPipe implements PipeTransform<unknown, string> {
  transform(valor: unknown, metadata: ArgumentMetadata): string {
    if (esUuid(valor)) return valor;
    const nombre = metadata.data ?? 'value';
    const razon = 'must be a UUID';
    throw new ErrorNegocio(400, CodigoError.VALIDATION_FAILED, `${nombre}: ${razon}`, {
      invalidParams: [{ name: nombre, reason: razon }],
    });
  }
}
