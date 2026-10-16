import { Module } from '@nestjs/common';
import { CifradoSecreto } from '../compartido/cifrado-secreto';
import { ClienteWebhook } from './cliente-webhook';
import { ClienteWebhookHttp } from './cliente-webhook-http';
import { EntregaRepository } from './entrega.repository';
import { EntregaWebhooks } from './entrega-webhooks';

/**
 * El proceso que vacía la bandeja de salida (entrega) enviando los POST firmados, fuera de toda
 * transacción. No tiene rutas. El HTTP va detrás de ClienteWebhook: las pruebas lo reemplazan.
 */
@Module({
  providers: [
    EntregaWebhooks,
    EntregaRepository,
    CifradoSecreto,
    { provide: ClienteWebhook, useClass: ClienteWebhookHttp },
  ],
  exports: [EntregaWebhooks],
})
export class EntregaModule {}
