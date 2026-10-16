import { SetMetadata } from '@nestjs/common';

export const ES_PUBLICO = 'esPublico';

/**
 * Marca una ruta (o un controller) que no exige token. Todo lo demás lo exige: JwtAuthGuard
 * es global y niega por defecto. Swagger (/api/docs) no pasa por los guards.
 */
export const Publico = () => SetMetadata(ES_PUBLICO, true);
