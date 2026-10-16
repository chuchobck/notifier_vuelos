import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createHmac, randomUUID } from 'node:crypto';
import * as dns from 'node:dns';
import * as dnsPromesas from 'node:dns/promises';
import * as request from 'supertest';
import { EventoWebhook } from '../src/modules/compartido/eventos-webhook';
import {
  ClienteWebhook,
  PeticionWebhook,
  ResultadoWebhook,
} from '../src/modules/entrega/cliente-webhook';
import { ClienteWebhookHttp } from '../src/modules/entrega/cliente-webhook-http';
import { EntregaRepository } from '../src/modules/entrega/entrega.repository';
import { EntregaWebhooks, REGLAS_ENTREGA } from '../src/modules/entrega/entrega-webhooks';
import { PrismaService } from '../src/prisma/prisma.service';
import { esperarWebhookPayload } from './utils/contrato';
import { crearApp } from './utils/crear-app';
import { Datos, sobre } from './utils/datos';
import { IdentidadFalsa } from './utils/identidad-falsa';
import { LimitesReiniciables } from './utils/limites';
import { Receptor } from './utils/receptor';
import { RelojDePrueba } from './utils/reloj';

/** El HTTP de las pruebas: cada prueba decide qué contesta y qué se le pidió. */
class ClienteControlable extends ClienteWebhook {
  llamadas: PeticionWebhook[] = [];
  modo: (peticion: PeticionWebhook) => Promise<ResultadoWebhook> = () => Promise.resolve(ok());

  enviar(peticion: PeticionWebhook): Promise<ResultadoWebhook> {
    this.llamadas.push(peticion);
    return this.modo(peticion);
  }

  de(url: string): PeticionWebhook[] {
    return this.llamadas.filter((l) => l.url === url);
  }
}

const ok = (codigoHttp = 200): ResultadoWebhook => ({ codigoHttp, error: null });
const falla = (codigoHttp: number | null, error: string | null = null): ResultadoWebhook => ({
  codigoHttp,
  error,
});

/**
 * La firma, calculada aquí sin el código del servicio (firma-webhook.ts): HMAC-SHA256 de
 * "timestamp.cuerpo" con el secreto, en hexadecimal, con el prefijo sha256=. Es lo que hace un
 * tercero para verificar.
 */
const firmaEsperada = (secreto: string, timestamp: string, cuerpo: string) =>
  `sha256=${createHmac('sha256', secreto).update(`${timestamp}.${cuerpo}`).digest('hex')}`;

describe('Entrega de webhooks', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  const cliente = new ClienteControlable();
  let identidad: IdentidadFalsa;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let entrega: EntregaWebhooks;
  let real: ClienteWebhookHttp;
  let receptor: Receptor;
  let datos: Datos;

  const entregasDe = (suscripcionId: string) =>
    prisma.db.entrega.findMany({
      where: { suscripcion_id: suscripcionId },
      orderBy: { id: 'asc' },
    });
  const unaEntrega = async (suscripcionId: string) => (await entregasDe(suscripcionId))[0];
  const minutos = (n: number) => n * 60_000;

  /** Una suscripción nueva de un dueño nuevo hacia el receptor (o la URL que se diga). */
  const nueva = async (
    eventos: EventoWebhook[] = ['booking.confirmed'],
    url = receptor.url(`/r/${randomUUID()}`),
  ) => {
    const dueno = datos.dueno();
    const { id, secreto } = await datos.suscribir(dueno, url, eventos);
    return { dueno, id, secreto, url };
  };

  /** Publica `cantidad` eventos de ese dueño y devuelve sus eventId. */
  const publicar = async (
    dueno: string,
    cantidad = 1,
    tipo: EventoWebhook = 'booking.confirmed',
  ) => {
    const ids: string[] = [];
    for (let i = 0; i < cantidad; i++) {
      const evento = sobre(tipo, dueno);
      await datos.publicar(evento).expect(202);
      ids.push(evento.eventId as string);
    }
    return ids;
  };

  /** Corre la entrega hasta que no quede nada por hacer ahora (lo de otras pruebas también). */
  const vaciar = async () => {
    for (let i = 0; i < 50; i++) {
      const r = await entrega.ejecutar();
      if (r.entregadas + r.reintentos + r.fallidas === 0) return;
    }
  };

  beforeAll(async () => {
    identidad = await IdentidadFalsa.iniciar(() => reloj.ahora());
    app = await crearApp({ identidad, reloj, limites, clienteWebhook: cliente });
    prisma = app.get(PrismaService);
    entrega = app.get(EntregaWebhooks);
    real = new ClienteWebhookHttp(app.get(ConfigService));
    receptor = new Receptor();
    await receptor.iniciar();
    datos = new Datos(app, identidad);
    // Lo que otras pruebas dejaron pendiente no se mezcla con lo de este archivo
    await vaciar();
  });

  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
    cliente.llamadas = [];
    cliente.modo = () => Promise.resolve(ok());
    receptor.recibidos = [];
    receptor.codigo = 200;
    receptor.mudo = false;
  });

  afterAll(async () => {
    // Sin suscripciones activas, lo que quede pendiente se cierra (FALLIDO, SUBSCRIPTION_INACTIVE)
    await datos.darDeBaja();
    reloj.adelantar(60 * 24);
    await vaciar();
    await receptor.detener();
    await app.close();
    await identidad.detener();
  });

  describe('del evento al tercero, con el HTTP real', () => {
    it('2xx: POST con las cinco cabeceras, firma verificable por código independiente y ENTREGADO', async () => {
      const { dueno, id, secreto, url } = await nueva();
      const [eventId] = await publicar(dueno);
      cliente.modo = (p) => real.enviar(p);

      await entrega.ejecutar();

      const [recibido] = receptor.recibidos.filter((r) => url.endsWith(r.ruta));
      expect(recibido).toBeDefined();
      const { cabeceras, cuerpo } = recibido;
      expect(cabeceras['content-type']).toBe('application/json');
      expect(cabeceras['x-webhook-event']).toBe('booking.confirmed');
      expect(cabeceras['x-webhook-id']).toBe(eventId);
      expect(cabeceras['x-webhook-timestamp']).toBe(
        String(Math.floor(reloj.ahora().getTime() / 1000)),
      );
      expect(cabeceras['x-webhook-signature']).toBe(
        firmaEsperada(secreto, cabeceras['x-webhook-timestamp'] as string, cuerpo),
      );
      // Con otro secreto, otro timestamp u otro cuerpo, la firma no coincide
      expect(cabeceras['x-webhook-signature']).not.toBe(
        firmaEsperada(`${secreto}x`, cabeceras['x-webhook-timestamp'] as string, cuerpo),
      );
      expect(cabeceras['x-webhook-signature']).not.toBe(firmaEsperada(secreto, '0', cuerpo));

      const payload = JSON.parse(cuerpo) as Record<string, unknown>;
      esperarWebhookPayload(payload);
      expect(payload).toEqual((await unaEntrega(id)).cuerpo);
      expect(payload).toMatchObject({
        eventId,
        eventType: 'booking.confirmed',
        apiVersion: '1.5.0',
      });
      expect(await unaEntrega(id)).toMatchObject({
        estado: 'ENTREGADO',
        intentos: 1,
        ultimo_codigo_http: 200,
        ultimo_error: null,
      });
    });

    it('500: queda PENDIENTE con HTTP_500 y se reintenta al minuto', async () => {
      const { dueno, id, url } = await nueva();
      await publicar(dueno);
      cliente.modo = (p) => real.enviar(p);
      receptor.codigo = 500;
      const inicio = reloj.ahora();

      await entrega.ejecutar();

      expect(receptor.recibidos.filter((r) => url.endsWith(r.ruta))).toHaveLength(1);
      const fila = await unaEntrega(id);
      expect(fila).toMatchObject({
        estado: 'PENDIENTE',
        intentos: 1,
        ultimo_codigo_http: 500,
        ultimo_error: 'HTTP_500',
      });
      expect(fila.proximo_intento.getTime()).toBe(inicio.getTime() + minutos(1));
    });

    it('plazo agotado: un receptor que no contesta se corta a los 5 s (TIMEOUT)', async () => {
      const { dueno, id } = await nueva();
      await publicar(dueno);
      cliente.modo = (p) => real.enviar(p);
      receptor.mudo = true;
      const antes = Date.now();

      await entrega.ejecutar();

      const demora = Date.now() - antes;
      expect(demora).toBeGreaterThanOrEqual(4900);
      expect(demora).toBeLessThan(9000);
      expect(await unaEntrega(id)).toMatchObject({
        estado: 'PENDIENTE',
        ultimo_codigo_http: null,
        ultimo_error: 'TIMEOUT',
      });
    }, 20_000);

    it('una IP literal de la metadata de la nube no recibe nada, aunque esté en la base', async () => {
      const { dueno, id } = await nueva();
      await prisma.db.suscripcion.update({
        where: { id },
        data: { url: 'http://169.254.169.254/latest/meta-data' },
      });
      await publicar(dueno);
      cliente.modo = (p) => real.enviar(p);
      await entrega.ejecutar();
      expect(await unaEntrega(id)).toMatchObject({
        estado: 'PENDIENTE',
        ultimo_codigo_http: null,
        ultimo_error: 'DESTINATION_NOT_ALLOWED',
      });
    });
  });

  describe('DNS que cambia después de registrar (DNS rebinding)', () => {
    const NOMBRE = 'hooks.rebinding.e2e.quinde.example';
    let dnsAlEnviar: string;

    beforeEach(() => {
      // Al registrar, el nombre resuelve a loopback (http solo se admite hacia loopback fuera de
      // producción); al enviar, a lo que diga la prueba
      jest
        .spyOn(dnsPromesas, 'lookup')
        .mockImplementation((async () => [{ address: '127.0.0.1', family: 4 }]) as never);
      jest.spyOn(dns, 'lookup').mockImplementation(((
        host: string,
        opciones: unknown,
        devolver: (e: Error | null, d: unknown, f?: number) => void,
      ) => {
        const lista = [{ address: host === NOMBRE ? dnsAlEnviar : '127.0.0.1', family: 4 }];
        if ((opciones as { all?: boolean }).all) devolver(null, lista);
        else devolver(null, lista[0].address, 4);
      }) as never);
    });
    afterEach(() => jest.restoreAllMocks());

    const conNombre = () => receptor.url('/rebinding').replace('127.0.0.1', NOMBRE);

    it('control: si al enviar sigue en loopback, el receptor recibe (el lookup es el que se usa)', async () => {
      dnsAlEnviar = '127.0.0.1';
      const { dueno, id } = await nueva(['booking.confirmed'], conNombre());
      await publicar(dueno);
      cliente.modo = (p) => real.enviar(p);
      await entrega.ejecutar();
      expect(receptor.de('/rebinding')).toHaveLength(1);
      expect((await unaEntrega(id)).estado).toBe('ENTREGADO');
    });

    it('si al enviar resuelve a una red privada (10.0.0.5), no se conecta: DESTINATION_NOT_ALLOWED', async () => {
      dnsAlEnviar = '127.0.0.1';
      const { dueno, id } = await nueva(['booking.confirmed'], conNombre());
      await publicar(dueno);
      dnsAlEnviar = '10.0.0.5';
      cliente.modo = (p) => real.enviar(p);
      await entrega.ejecutar();
      expect(receptor.de('/rebinding')).toHaveLength(0);
      expect(await unaEntrega(id)).toMatchObject({
        estado: 'PENDIENTE',
        ultimo_codigo_http: null,
        ultimo_error: 'DESTINATION_NOT_ALLOWED',
      });
    });

    it('lo mismo con la metadata de la nube (169.254.169.254) y con una IPv4 dentro de IPv6', async () => {
      for (const direccion of ['169.254.169.254', '::ffff:192.168.1.10']) {
        dnsAlEnviar = '127.0.0.1';
        const { dueno, id } = await nueva(['booking.confirmed'], conNombre());
        await publicar(dueno);
        dnsAlEnviar = direccion;
        cliente.modo = (p) => real.enviar(p);
        await entrega.ejecutar();
        expect((await unaEntrega(id)).ultimo_error).toBe('DESTINATION_NOT_ALLOWED');
      }
      expect(receptor.de('/rebinding')).toHaveLength(0);
    });
  });

  describe('reintentos con espera creciente (reloj de la prueba)', () => {
    it('1 min, 5 min, 30 min, 2 h y al quinto intento fallido queda FALLIDO', async () => {
      const { dueno, id, url } = await nueva();
      const [eventId] = await publicar(dueno);
      cliente.modo = () => Promise.resolve(falla(500));
      const esperas = [1, 5, 30, 120];
      for (let intento = 1; intento <= 5; intento++) {
        const inicio = reloj.ahora();
        await entrega.ejecutar();
        const fila = await unaEntrega(id);
        expect(cliente.de(url)).toHaveLength(intento);
        expect(fila.intentos).toBe(intento);
        expect(fila).toMatchObject({ ultimo_codigo_http: 500, ultimo_error: 'HTTP_500' });
        if (intento < 5) {
          expect(fila.estado).toBe('PENDIENTE');
          expect(fila.proximo_intento.getTime()).toBe(
            inicio.getTime() + minutos(esperas[intento - 1]),
          );
          // Antes de la hora no se vuelve a intentar
          reloj.adelantar(esperas[intento - 1] - 0.5);
          await entrega.ejecutar();
          expect(cliente.de(url)).toHaveLength(intento);
          reloj.adelantar(0.5);
        } else {
          expect(fila.estado).toBe('FALLIDO');
        }
      }
      // FALLIDO es definitivo: ni adelantando un día se vuelve a enviar
      reloj.adelantar(60 * 24);
      await entrega.ejecutar();
      expect(cliente.de(url)).toHaveLength(5);
      // Los cinco envíos llevaron el mismo cuerpo y el mismo eventId (para que el receptor deduplique)
      expect(new Set(cliente.de(url).map((l) => l.cuerpo)).size).toBe(1);
      expect(new Set(cliente.de(url).map((l) => l.cabeceras['X-Webhook-Id']))).toEqual(
        new Set([eventId]),
      );
      // ...pero cada uno con su timestamp y su firma
      const marcas = cliente.de(url).map((l) => Number(l.cabeceras['X-Webhook-Timestamp']));
      expect(new Set(marcas).size).toBe(5);
    });

    it('si a la tercera responde 2xx, queda ENTREGADO con 3 intentos y sin error', async () => {
      const { dueno, id, url } = await nueva();
      await publicar(dueno);
      const respuestas = [falla(503), falla(null, 'ECONNRESET'), ok(204)];
      cliente.modo = () => Promise.resolve(respuestas.shift() as ResultadoWebhook);
      await entrega.ejecutar();
      expect(await unaEntrega(id)).toMatchObject({ estado: 'PENDIENTE', ultimo_error: 'HTTP_503' });
      reloj.adelantar(1);
      await entrega.ejecutar();
      expect(await unaEntrega(id)).toMatchObject({
        estado: 'PENDIENTE',
        ultimo_codigo_http: null,
        ultimo_error: 'ECONNRESET',
      });
      reloj.adelantar(5);
      await entrega.ejecutar();
      expect(await unaEntrega(id)).toMatchObject({
        estado: 'ENTREGADO',
        intentos: 3,
        ultimo_codigo_http: 204,
        ultimo_error: null,
      });
      expect(cliente.de(url)).toHaveLength(3);
    });

    it('una redirección (3xx) o un 4xx cuentan como fallo, no como entregado', async () => {
      const { dueno, id } = await nueva();
      await publicar(dueno, 2);
      const codigos = [302, 410];
      cliente.modo = () => Promise.resolve(falla(codigos.shift() as number));
      await entrega.ejecutar();
      const filas = await entregasDe(id);
      expect(filas.map((f) => [f.estado, f.ultimo_error]).sort()).toEqual([
        ['PENDIENTE', 'HTTP_302'],
        ['PENDIENTE', 'HTTP_410'],
      ]);
    });

    it('un secreto que ya no se puede descifrar es un fallo con código, sin tirar la corrida', async () => {
      const { dueno, id, url } = await nueva();
      await prisma.db.suscripcion.update({
        where: { id },
        data: { secreto_cifrado: `v1.${'A'.repeat(60)}` },
      });
      await publicar(dueno);
      await entrega.ejecutar();
      expect(cliente.de(url)).toEqual([]);
      expect(await unaEntrega(id)).toMatchObject({
        estado: 'PENDIENTE',
        ultimo_error: 'SECRET_UNREADABLE',
      });
    });

    it('una suscripción dada de baja ya no recibe: sus pendientes se cierran sin enviar', async () => {
      const { dueno, id, url } = await nueva();
      await publicar(dueno, 3);
      await request(app.getHttpServer())
        .delete(`/flights/v1/webhooks/${id}`)
        .set('Authorization', `Bearer ${datos.tokenDe(dueno)}`)
        .expect(204);
      await entrega.ejecutar();
      expect(cliente.de(url)).toEqual([]);
      const filas = await entregasDe(id);
      expect(filas.map((f) => [f.estado, f.ultimo_error])).toEqual(
        Array(3).fill(['FALLIDO', 'SUBSCRIPTION_INACTIVE']),
      );
    });

    it('un envío que tarda no deja pasar a otra corrida del mismo proceso (una a la vez)', async () => {
      const { dueno, url } = await nueva();
      await publicar(dueno);
      const pendientes: Array<() => void> = [];
      cliente.modo = () =>
        new Promise((resolver) => {
          pendientes.push(() => resolver(ok()));
        });
      const primera = entrega.ejecutar();
      const segunda = entrega.ejecutar();
      expect(segunda).toBe(primera);
      await new Promise((r) => setTimeout(r, 200));
      pendientes.forEach((liberar) => liberar());
      await primera;
      expect(cliente.de(url)).toHaveLength(1);
    });
  });

  describe('arrendamiento', () => {
    it('si el proceso muere a mitad de un envío, la entrega vuelve sola al vencer el arrendamiento', async () => {
      const { dueno, id, url } = await nueva();
      await publicar(dueno);
      // Un proceso la toma y "muere": nunca anota el resultado
      const tomadas = await app
        .get(EntregaRepository)
        .reclamar(reloj.ahora(), 200, REGLAS_ENTREGA.arrendamientoSegundos);
      expect(tomadas.filter((t) => t.suscripcionId === id)).toHaveLength(1);
      // Mientras dura el arrendamiento nadie más la toma
      reloj.adelantar(REGLAS_ENTREGA.arrendamientoSegundos / 60 - 0.1);
      await entrega.ejecutar();
      expect(cliente.de(url)).toEqual([]);
      reloj.adelantar(0.2);
      await entrega.ejecutar();
      expect(cliente.de(url)).toHaveLength(1);
      expect(await unaEntrega(id)).toMatchObject({ estado: 'ENTREGADO', intentos: 2 });
    });

    it('los resultados atrasados de un intento viejo no pisan al nuevo', async () => {
      const { dueno, id } = await nueva();
      await publicar(dueno);
      const repositorio = app.get(EntregaRepository);
      const [primera] = (await repositorio.reclamar(reloj.ahora(), 200, 60)).filter(
        (t) => t.suscripcionId === id,
      );
      reloj.adelantar(2);
      const [segunda] = (await repositorio.reclamar(reloj.ahora(), 200, 60)).filter(
        (t) => t.suscripcionId === id,
      );
      expect([primera.intentos, segunda.intentos]).toEqual([1, 2]);
      expect(
        await repositorio.registrarResultado(primera.id, 1, reloj.ahora(), ok(), null),
      ).toBeNull();
      expect(await repositorio.registrarResultado(segunda.id, 2, reloj.ahora(), ok(), null)).toBe(
        'ENTREGADO',
      );
      expect(await unaEntrega(id)).toMatchObject({ estado: 'ENTREGADO', intentos: 2 });
    });
  });

  describe('una suscripción que solo falla se da de baja', () => {
    /** Falla todas las pendientes de la suscripción hasta dejarlas FALLIDO (5 intentos). */
    const fallarHastaElFinal = async () => {
      cliente.modo = () => Promise.resolve(falla(500));
      for (const espera of [1, 5, 30, 120, 0]) {
        await entrega.ejecutar();
        reloj.adelantar(espera);
      }
    };

    it('10 entregas FALLIDO seguidas la desactivan (con auditoría sin actor) y 9 no', async () => {
      const { dueno, id } = await nueva();
      // Una entregada corta la racha
      await publicar(dueno);
      await entrega.ejecutar();
      reloj.adelantar(1);
      await publicar(dueno, 9);
      await fallarHastaElFinal();
      const filas = await entregasDe(id);
      expect(filas.filter((f) => f.estado === 'FALLIDO')).toHaveLength(9);
      const activa = async () =>
        (await prisma.db.suscripcion.findUniqueOrThrow({ where: { id } })).activo;
      // 9 FALLIDO + 1 ENTREGADO entre las últimas 10: sigue activa
      expect(await activa()).toBe(true);

      await publicar(dueno);
      await fallarHastaElFinal();
      expect(await activa()).toBe(false);

      const lista = await request(app.getHttpServer())
        .get('/flights/v1/webhooks')
        .set('Authorization', `Bearer ${datos.tokenDe(dueno)}`)
        .expect(200);
      expect(lista.body).toEqual([]);
      const auditoria = await prisma.db.auditoria.findMany({
        where: { suscripcion_id: id, accion: 'SUSCRIPCION_DESACTIVADA' },
      });
      expect(auditoria).toHaveLength(1);
      expect(auditoria[0]).toMatchObject({
        actor: null,
        motivo: 'FALLIDAS_SEGUIDAS',
        id_propietario: dueno,
        eventos: ['booking.confirmed'],
      });
    }, 30_000);
  });

  describe('dos procesos a la vez', () => {
    it('reclamar a la vez nunca da la misma entrega a los dos', async () => {
      const { dueno, id } = await nueva();
      await publicar(dueno, 30);
      const repositorio = app.get(EntregaRepository);
      const ahora = reloj.ahora();
      const tandas = await Promise.all(
        Array.from({ length: 4 }, () => repositorio.reclamar(ahora, 12, 120)),
      );
      const ids = tandas
        .flat()
        .filter((t) => t.suscripcionId === id)
        .map((t) => String(t.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(30);
      expect(tandas.flat().every((t) => t.intentos === 1)).toBe(true);
    });

    it('dos instancias del servicio (dos apps) con 60 entregas: cada eventId llega exactamente una vez', async () => {
      const ruta = `/conc/${randomUUID()}`;
      const { dueno, id } = await nueva(['booking.confirmed'], receptor.url(ruta));
      const ids = await publicar(dueno, 60);
      const conLatencia = async (p: PeticionWebhook) => {
        // un poco de latencia para que las dos instancias de verdad se crucen
        await new Promise((r) => setTimeout(r, 5));
        return real.enviar(p);
      };
      cliente.modo = conLatencia;
      const otraCliente = new ClienteControlable();
      otraCliente.modo = conLatencia;
      const otra = await crearApp({ identidad, reloj, clienteWebhook: otraCliente });
      try {
        await Promise.all([entrega.ejecutar(), otra.get(EntregaWebhooks).ejecutar()]);
      } finally {
        await otra.close();
      }

      const recibidos = receptor
        .de(ruta)
        .map((r) => (JSON.parse(r.cuerpo) as { eventId: string }).eventId);
      expect(recibidos).toHaveLength(60);
      expect([...recibidos].sort()).toEqual([...ids].sort());
      // Las dos trabajaron
      expect(cliente.de(receptor.url(ruta)).length).toBeGreaterThan(0);
      expect(otraCliente.de(receptor.url(ruta)).length).toBeGreaterThan(0);
      const filas = await entregasDe(id);
      expect(filas.every((f) => f.estado === 'ENTREGADO' && f.intentos === 1)).toBe(true);
    });
  });

  describe('lo que se registra', () => {
    it('cada intento deja una línea sin URL, secreto, firma ni cuerpo', async () => {
      const url = receptor.url(`/log/${randomUUID()}?token=tokendeprueba`);
      const dueno = datos.dueno();
      const { id } = await datos.suscribir(
        dueno,
        url,
        ['booking.cancelled'],
        'secreto-que-no-debe-salir-1',
      );
      const [eventId] = await publicar(dueno, 1, 'booking.cancelled');
      const lineas: string[] = [];
      const espiar = (nivel: 'log' | 'warn' | 'error') =>
        jest
          .spyOn(Logger.prototype, nivel)
          .mockImplementation((...partes: unknown[]) => void lineas.push(partes.join(' ')));
      const espias = [espiar('log'), espiar('warn'), espiar('error')];
      try {
        receptor.codigo = 500;
        cliente.modo = (p) => real.enviar(p);
        await entrega.ejecutar();
        receptor.codigo = 200;
        reloj.adelantar(1);
        await entrega.ejecutar();
      } finally {
        espias.forEach((e) => e.mockRestore());
      }
      const mias = lineas.filter((l) => l.includes('Entrega'));
      expect(mias.length).toBeGreaterThanOrEqual(2);
      const texto = mias.join('\n');
      expect(texto).toMatch(/Entrega \d+ \(booking\.cancelled\) intento 1\/5: PENDIENTE 500/);
      expect(texto).toMatch(/intento 2\/5: ENTREGADO 200/);
      const firmas = receptor.recibidos.map((r) => r.cabeceras['x-webhook-signature'] as string);
      expect(firmas.length).toBeGreaterThanOrEqual(2);
      for (const prohibido of [
        'secreto-que-no-debe-salir-1',
        'tokendeprueba',
        '127.0.0.1',
        'Q7K2MX',
        'sha256=',
        ...firmas,
        id,
        eventId,
      ]) {
        expect(texto).not.toContain(prohibido);
      }
    });
  });
});
