import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { AlmacenLimites } from '../../src/common/guards/almacen-limites';
import { Reloj } from '../../src/common/reloj';

/**
 * Contadores del límite de peticiones que una prueba puede poner en cero. Las pruebas que
 * repiten muchas peticiones sobre una misma app los reinician entre una y otra; las
 * que prueban el límite usan una app sin esto. Se pasa a crearApp({ limites }), que le da el
 * reloj de la prueba (o uno quieto): nunca dependen del reloj de la máquina.
 */
export class LimitesReiniciables implements ThrottlerStorage {
  private actual: AlmacenLimites | undefined;

  usarReloj(reloj: Reloj): void {
    this.actual?.onApplicationShutdown();
    this.actual = new AlmacenLimites(reloj);
  }

  increment(
    ...argumentos: Parameters<ThrottlerStorage['increment']>
  ): Promise<ThrottlerStorageRecord> {
    if (!this.actual) throw new Error('LimitesReiniciables sin reloj: pásalo a crearApp');
    return this.actual.increment(...argumentos);
  }

  reiniciar(): void {
    this.actual?.reiniciar();
  }
}
