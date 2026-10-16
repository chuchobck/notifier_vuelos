import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { Reloj } from '../reloj';

/** Cada cuánto se quitan de memoria los contadores sin peticiones vigentes. */
const BARRIDO_MS = 60_000;

interface Contador {
  ventanaMs: number;
  /** Instantes (ms) de las peticiones contadas, del más viejo al más nuevo. */
  instantes: number[];
}

/**
 * Contadores del límite de peticiones, en memoria, con la hora del `Reloj` inyectable (el
 * almacén de @nestjs/throttler usa `Date.now()` y las pruebas no lo pueden mover).
 *
 * Ventana deslizante: cuenta las peticiones de los últimos `ttl` ms; al llegar al límite, la
 * siguiente se rechaza hasta que la más vieja salga de la ventana (`Retry-After`). Una
 * rechazada no cuenta.
 *
 * Saltos de reloj: si la hora retrocede, una petición anotada "en el futuro" se toma como hecha
 * ahora, así un bloqueo nunca dura más de una ventana; si avanza, las peticiones viejas salen
 * antes (el límite se afloja, nunca bloquea de más). `Retry-After` queda siempre entre 1 y la
 * ventana.
 */
@Injectable()
export class AlmacenLimites implements ThrottlerStorage, OnApplicationShutdown {
  private readonly contadores = new Map<string, Contador>();
  private barrido: NodeJS.Timeout | undefined;

  constructor(private readonly reloj: Reloj) {}

  increment(
    clave: string,
    ttl: number,
    limite: number,
    _bloqueo: number,
    nombre: string,
  ): Promise<ThrottlerStorageRecord> {
    this.iniciarBarrido();
    const ahora = this.reloj.ahora().getTime();
    const id = `${nombre}\u0000${clave}`;
    const instantes = vigentes(this.contadores.get(id)?.instantes ?? [], ahora, ttl);
    const bloqueado = instantes.length >= limite;
    if (!bloqueado) instantes.push(ahora);
    this.contadores.set(id, { ventanaMs: ttl, instantes });

    const segundos = Math.min(
      Math.ceil(ttl / 1000),
      Math.max(1, Math.ceil((instantes[0] + ttl - ahora) / 1000)),
    );
    return Promise.resolve({
      totalHits: instantes.length + (bloqueado ? 1 : 0),
      timeToExpire: segundos,
      isBlocked: bloqueado,
      timeToBlockExpire: bloqueado ? segundos : 0,
    });
  }

  /** Borra todos los contadores (las pruebas lo usan entre casos). */
  reiniciar(): void {
    this.contadores.clear();
  }

  onApplicationShutdown(): void {
    clearInterval(this.barrido);
    this.barrido = undefined;
    this.contadores.clear();
  }

  private iniciarBarrido(): void {
    if (this.barrido) return;
    this.barrido = setInterval(() => {
      const ahora = this.reloj.ahora().getTime();
      for (const [id, contador] of this.contadores) {
        if (vigentes(contador.instantes, ahora, contador.ventanaMs).length === 0) {
          this.contadores.delete(id);
        }
      }
    }, BARRIDO_MS);
    this.barrido.unref();
  }
}

/** Las peticiones dentro de la ventana; una "del futuro" (el reloj retrocedió) cuenta como ahora. */
function vigentes(instantes: readonly number[], ahora: number, ventanaMs: number): number[] {
  return instantes.map((t) => Math.min(t, ahora)).filter((t) => t > ahora - ventanaMs);
}
