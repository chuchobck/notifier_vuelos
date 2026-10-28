import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as request from 'supertest';
import { EventoWebhook, TipoEvento } from '../../src/modules/compartido/eventos-webhook';
import { PrismaService } from '../../src/prisma/prisma.service';
import { IdentidadFalsa } from './identidad-falsa';

/**
 * Datos de las pruebas. Las pruebas no borran: cada una usa dueños nuevos (uuid al azar), así no
 * ven lo de otras corridas, y al final `darDeBaja` desactiva sus suscripciones (las entregas que
 * queden pendientes se cierran solas sin enviarse: su suscripción ya no está activa).
 */
export class Datos {
  private readonly duenos = new Set<string>();

  constructor(
    private readonly app: INestApplication,
    private readonly identidad: IdentidadFalsa,
  ) {}

  /** Un dueño nuevo (el `sub` de una persona) que se dará de baja al final. */
  dueno(): string {
    const id = randomUUID();
    this.duenos.add(id);
    return id;
  }

  tokenDe(dueno: string, scope = 'flights:webhooks'): string {
    return this.identidad.firmar({ sub: dueno, scope });
  }

  /** Registra una suscripción por la API (POST /flights/v1/webhooks) y devuelve su id. */
  async suscribir(
    dueno: string,
    url: string,
    eventos: EventoWebhook[],
    secreto = `secreto-e2e-${randomUUID()}`,
  ): Promise<{ id: string; secreto: string }> {
    const respuesta = await request(this.app.getHttpServer())
      .post('/flights/v1/webhooks')
      .set('Authorization', `Bearer ${this.tokenDe(dueno)}`)
      .send({ url, events: eventos, secret: secreto });
    if (respuesta.status !== 201) {
      throw new Error(
        `No se pudo suscribir: ${respuesta.status} ${JSON.stringify(respuesta.body)}`,
      );
    }
    return { id: (respuesta.body as { id: string }).id, secreto };
  }

  /** Registra una suscripción v2 (POST /api/v2/vuelos/webhooks) y devuelve su id. */
  async suscribirV2(
    dueno: string,
    url: string,
    eventos: TipoEvento[],
    secreto = `secreto-e2e-${randomUUID()}`,
  ): Promise<{ id: string; secreto: string }> {
    const respuesta = await request(this.app.getHttpServer())
      .post('/api/v2/vuelos/webhooks')
      .set('Authorization', `Bearer ${this.tokenDe(dueno)}`)
      .send({ url, events: eventos, secret: secreto });
    if (respuesta.status !== 201) {
      throw new Error(
        `No se pudo suscribir (v2): ${respuesta.status} ${JSON.stringify(respuesta.body)}`,
      );
    }
    return { id: (respuesta.body as { id: string }).id, secreto };
  }

  /** POST /internal/v1/events con el token del core. */
  publicar(cuerpo: unknown, token = this.identidad.firmarPublicador()) {
    return request(this.app.getHttpServer())
      .post('/internal/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .send(cuerpo as object);
  }

  /** Da de baja (lógica) las suscripciones de los dueños de esta prueba. */
  async darDeBaja(): Promise<void> {
    if (this.duenos.size === 0) return;
    await this.app.get(PrismaService).db.suscripcion.updateMany({
      where: { id_propietario: { in: [...this.duenos] }, activo: true },
      data: { activo: false },
    });
  }
}

/**
 * Un ejemplo del esquema de un tipo (contracts/events/<tipo>.v1.json): el primero (1.0) por
 * defecto; `indice` 1 es el de 1.1 (con correlationId y la data ampliada) en los 12 tipos de v1.
 */
export function ejemplo(tipo: TipoEvento, indice = 0): Record<string, unknown> {
  const esquema = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'contracts', 'events', `${tipo}.v1.json`), 'utf8'),
  ) as { examples: Array<Record<string, unknown>> };
  return structuredClone(esquema.examples[indice]);
}

/** Un sobre válido de ese tipo para ese dueño, con un eventId nuevo. */
export function sobre(
  tipo: TipoEvento,
  dueno: string,
  cambios: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...ejemplo(tipo), eventId: randomUUID(), ownerId: dueno, ...cambios };
}
