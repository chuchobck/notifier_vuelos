import { EventoAceptadoDto } from './dto/evento.dto';
import { ResultadoPublicacion } from './evento.modelo';

export function aEventoAceptado(resultado: ResultadoPublicacion): EventoAceptadoDto {
  return {
    eventId: resultado.eventId,
    deliveries: resultado.entregas,
    duplicate: resultado.duplicado,
  };
}
