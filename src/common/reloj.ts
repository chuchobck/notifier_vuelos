import { Injectable } from '@nestjs/common';

/**
 * La hora de la aplicación. Quien decide si algo venció (tokens de acceso, tokens de refresco,
 * límites de peticiones) la pide aquí en lugar de llamar a `new Date()`: las pruebas
 * reemplazan este provider por uno que se puede adelantar, sin esperas reales y sin depender
 * del reloj de la máquina.
 */
@Injectable()
export class Reloj {
  ahora(): Date {
    return new Date();
  }
}
