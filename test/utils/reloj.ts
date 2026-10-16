import { Reloj } from '../../src/common/reloj';

const MINUTO = 60_000;

/**
 * Reloj quieto para las pruebas: no avanza solo, solo cuando la prueba lo adelanta. Así un
 * vencimiento se prueba sin esperas reales y sin depender del reloj de la máquina (el de WSL
 * salta minutos de golpe). Se pasa a crearApp({ reloj }).
 */
export class RelojDePrueba extends Reloj {
  private instante = new Date();

  override ahora(): Date {
    return new Date(this.instante);
  }

  adelantar(minutos: number): void {
    this.instante = new Date(this.instante.getTime() + minutos * MINUTO);
  }

  /** Lo deja exactamente en `instante` (un token firmado en el pasado, por ejemplo). */
  fijar(instante: Date): void {
    this.instante = new Date(instante);
  }

  /** Vuelve a la hora real de la máquina (al empezar cada prueba). */
  alPresente(): void {
    this.instante = new Date();
  }
}
