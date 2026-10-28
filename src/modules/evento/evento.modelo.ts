import { SobreEvento } from './contrato/registro-esquemas';

export interface ResultadoPublicacion {
  eventId: string;
  /** Entregas que tiene el evento (una por suscripción activa del dueño que escucha el tipo). */
  entregas: number;
  /** El eventId ya estaba guardado con el mismo contenido: no se hizo nada. */
  duplicado: boolean;
}

export type { SobreEvento };
