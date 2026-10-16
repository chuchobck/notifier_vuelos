import { NestExpressApplication } from '@nestjs/platform-express';
import { createCipheriv, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as request from 'supertest';
import { importarArchivo } from '../src/cli/importar-suscripciones';
import { EntregaWebhooks } from '../src/modules/entrega/entrega-webhooks';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearApp } from './utils/crear-app';
import { Datos, sobre } from './utils/datos';
import { IdentidadFalsa } from './utils/identidad-falsa';
import { Receptor } from './utils/receptor';
import { RelojDePrueba } from './utils/reloj';

/**
 * npm run suscripciones:importar: el archivo que exportará el core (docs/MIGRACION.md). Los
 * secretos se cifran aquí como lo hace el core (AES-256-GCM, HKDF con sal quinde-vuelos e info
 * webhook-secreto) con la WEBHOOK_SECRET_KEY de las pruebas: es la migración real, donde los dos
 * servicios comparten la clave.
 */
const cifrarComoElCore = (secreto: string, clave = process.env.WEBHOOK_SECRET_KEY as string) => {
  const llave = Buffer.from(hkdfSync('sha256', clave, 'quinde-vuelos', 'webhook-secreto', 32));
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', llave, nonce);
  const cuerpo = Buffer.concat([c.update(secreto, 'utf8'), c.final()]);
  return `v1.${Buffer.concat([nonce, c.getAuthTag(), cuerpo]).toString('base64url')}`;
};

describe('Importar las suscripciones del core', () => {
  const reloj = new RelojDePrueba();
  let identidad: IdentidadFalsa;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let datos: Datos;
  let receptor: Receptor;
  let carpeta: string;
  const salida: string[] = [];
  const duenos: string[] = [];

  const dueno = () => {
    const id = randomUUID();
    duenos.push(id);
    return id;
  };
  const linea = (cambios: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    idPropietario: dueno(),
    url: `https://hooks.e2e.quinde.example/${randomUUID()}?token=token-de-la-url`,
    secretoCifrado: cifrarComoElCore(`secreto-del-core-${randomUUID()}`),
    eventos: ['booking.confirmed', 'hold.expired'],
    activo: true,
    ...cambios,
  });
  const archivo = (lineas: Array<object | string>) => {
    const ruta = join(carpeta, `${randomUUID()}.jsonl`);
    writeFileSync(
      ruta,
      lineas.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'),
    );
    return ruta;
  };
  const importar = async (ruta: string) => {
    salida.length = 0;
    const codigo = await importarArchivo(ruta, (l) => salida.push(l));
    return { codigo, texto: salida.join('\n') };
  };

  beforeAll(async () => {
    carpeta = mkdtempSync(join(tmpdir(), 'importacion-'));
    identidad = await IdentidadFalsa.iniciar(() => reloj.ahora());
    app = await crearApp({ identidad, reloj });
    prisma = app.get(PrismaService);
    datos = new Datos(app, identidad);
    receptor = new Receptor();
    await receptor.iniciar();
  });

  afterAll(async () => {
    await prisma.db.suscripcion.updateMany({
      where: { id_propietario: { in: duenos }, activo: true },
      data: { activo: false },
    });
    await datos.darDeBaja();
    await receptor.detener();
    await app.close();
    await identidad.detener();
    rmSync(carpeta, { recursive: true, force: true });
  });

  it('importa, conserva el id, el secreto cifrado tal cual y la fecha; y audita sin secreto ni URL', async () => {
    const fecha = '2026-10-01T10:00:00.000Z';
    const activa = linea({ fechaCreacion: fecha });
    const inactiva = linea({ activo: false, eventos: ['booking.cancelled'] });
    const { codigo, texto } = await importar(archivo([activa, '', inactiva]));

    expect(codigo).toBe(0);
    expect(texto).toContain('Importadas: 2 · ya existían: 0 · rechazadas: 0');
    const fila = await prisma.db.suscripcion.findUniqueOrThrow({
      where: { id: activa.id },
      include: { suscripcion_evento: true },
    });
    expect(fila).toMatchObject({
      id_propietario: activa.idPropietario,
      url: activa.url,
      secreto_cifrado: activa.secretoCifrado,
      activo: true,
    });
    expect(fila.fecha_creacion.toISOString()).toBe(fecha);
    expect(fila.suscripcion_evento.map((e) => e.tipo_evento).sort()).toEqual([
      'booking.confirmed',
      'hold.expired',
    ]);
    expect(
      (await prisma.db.suscripcion.findUniqueOrThrow({ where: { id: inactiva.id } })).activo,
    ).toBe(false);

    const auditoria = await prisma.db.auditoria.findMany({
      where: { suscripcion_id: { in: [activa.id, inactiva.id] } },
      orderBy: { id: 'asc' },
    });
    expect(auditoria.map((a) => [a.accion, a.actor, a.motivo, a.host_destino])).toEqual([
      ['SUSCRIPCION_IMPORTADA', null, null, 'hooks.e2e.quinde.example'],
      ['SUSCRIPCION_IMPORTADA', null, 'IMPORTADA_INACTIVA', 'hooks.e2e.quinde.example'],
    ]);
    const textoAuditoria = JSON.stringify(auditoria, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(textoAuditoria).not.toContain('token-de-la-url');
    expect(textoAuditoria).not.toContain(activa.secretoCifrado);
  });

  it('es idempotente: la segunda vez cuenta las que ya existían y no cambia nada', async () => {
    const lineas = [linea(), linea(), linea({ activo: false })];
    const ruta = archivo(lineas);
    expect((await importar(ruta)).texto).toContain('Importadas: 3 · ya existían: 0');
    const despues = await prisma.db.suscripcion.findMany({
      where: { id: { in: lineas.map((l) => l.id) } },
      orderBy: { id: 'asc' },
    });

    const segunda = await importar(ruta);
    expect(segunda.codigo).toBe(0);
    expect(segunda.texto).toContain('Importadas: 0 · ya existían: 3 · rechazadas: 0');
    expect(
      await prisma.db.suscripcion.findMany({
        where: { id: { in: lineas.map((l) => l.id) } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(despues);
    expect(
      await prisma.db.auditoria.count({
        where: { suscripcion_id: { in: lineas.map((l) => l.id) } },
      }),
    ).toBe(3);
  });

  it('dos importaciones a la vez del mismo archivo no duplican nada', async () => {
    const lineas = Array.from({ length: 10 }, () => linea());
    const ruta = archivo(lineas);
    const salidaA: string[] = [];
    const salidaB: string[] = [];
    const [ca, cb] = await Promise.all([
      importarArchivo(ruta, (l) => salidaA.push(l)),
      importarArchivo(ruta, (l) => salidaB.push(l)),
    ]);
    expect([ca, cb]).toEqual([0, 0]);
    // Entre las dos, cada línea entró una sola vez
    const total = (texto: string, que: string) =>
      Number(new RegExp(`${que}: (\\d+)`).exec(texto)?.[1]);
    const [ta, tb] = [salidaA.join('\n'), salidaB.join('\n')];
    expect(total(ta, 'Importadas') + total(tb, 'Importadas')).toBe(10);
    expect(total(ta, 'ya existían') + total(tb, 'ya existían')).toBe(10);
    expect(
      await prisma.db.suscripcion.count({ where: { id: { in: lineas.map((l) => l.id) } } }),
    ).toBe(10);
    expect(
      await prisma.db.auditoria.count({
        where: { suscripcion_id: { in: lineas.map((l) => l.id) } },
      }),
    ).toBe(10);
  });

  it('rechaza la línea cuyo secreto no se descifra con la clave actual (y las demás entran)', async () => {
    const buena = linea();
    const otraClave = linea({ secretoCifrado: cifrarComoElCore('secreto-x', 'y'.repeat(40)) });
    const { codigo, texto } = await importar(archivo([buena, otraClave]));
    expect(codigo).toBe(1);
    expect(texto).toContain(
      'línea 2: rechazada (secretoCifrado: no se puede descifrar con la WEBHOOK_SECRET_KEY actual)',
    );
    expect(texto).toContain('Importadas: 1 · ya existían: 0 · rechazadas: 1');
    expect(await prisma.db.suscripcion.count({ where: { id: otraClave.id } })).toBe(0);
  });

  it.each<[string, string | object, string]>([
    ['no es JSON', '{no es json', 'no es JSON'],
    [
      'un campo de más (un secreto en claro, por ejemplo)',
      { secreto: 'en-claro' },
      'campos que el formato no tiene',
    ],
    ['sin eventos', { eventos: [] }, 'eventos:'],
    ['un tipo de evento desconocido', { eventos: ['booking.created'] }, 'eventos:'],
    ['un id que no es uuid', { id: '42' }, 'id: debe ser un uuid'],
    ['una URL que no es http(s)', { url: 'ftp://hooks.example.com/x' }, 'url:'],
    ['un secreto en claro', { secretoCifrado: 'un-secreto-en-claro-1234' }, 'secretoCifrado:'],
    ['activo que no es booleano', { activo: 'si' }, 'activo:'],
    ['una fecha en el futuro', { fechaCreacion: '2999-01-01T00:00:00Z' }, 'fechaCreacion:'],
  ])('rechaza %s, nombrando el campo y sin repetir valores', async (_caso, cambios, motivo) => {
    const mala = typeof cambios === 'string' ? cambios : { ...linea(), ...cambios };
    const { codigo, texto } = await importar(archivo([mala]));
    expect(codigo).toBe(1);
    expect(texto).toContain(`línea 1: rechazada (${motivo}`);
    for (const valor of [
      'en-claro',
      'ftp://',
      'un-secreto-en-claro',
      'token-de-la-url',
      'hooks.e2e',
    ]) {
      expect(texto).not.toContain(valor);
    }
  });

  it('rechaza una activa si el dueño ya tiene otra activa con esa URL; una inactiva sí entra', async () => {
    const primera = linea();
    const repetida = linea({ idPropietario: primera.idPropietario, url: primera.url });
    const inactiva = linea({
      idPropietario: primera.idPropietario,
      url: primera.url,
      activo: false,
    });
    const { texto } = await importar(archivo([primera, repetida, inactiva]));
    expect(texto).toContain(
      'línea 2: rechazada (url: el dueño ya tiene otra suscripción activa con esa URL)',
    );
    expect(texto).toContain('Importadas: 2 · ya existían: 0 · rechazadas: 1');
  });

  it('la salida nunca trae un secreto, un secreto cifrado ni una URL', async () => {
    const lineas = [
      linea(),
      linea({ eventos: ['nada'] }),
      linea({ secretoCifrado: cifrarComoElCore('z', 'w'.repeat(40)) }),
    ];
    const { texto } = await importar(archivo(lineas));
    for (const l of lineas) {
      expect(texto).not.toContain(l.secretoCifrado);
      expect(texto).not.toContain(l.url);
      expect(texto).not.toContain(l.idPropietario);
    }
    expect(texto).not.toContain('secreto-del-core');
  });

  it('sin archivo, o con uno que no existe: código 2', async () => {
    expect(await importarArchivo(undefined, () => undefined)).toBe(2);
    expect(await importarArchivo(join(carpeta, 'no-existe.jsonl'), () => undefined)).toBe(2);
  });

  it('una suscripción importada firma sus entregas con el secreto ORIGINAL del core: el tercero no cambia nada', async () => {
    const secreto = `secreto-que-el-tercero-ya-tiene-${randomUUID()}`;
    const ruta = `/migrada/${randomUUID()}`;
    const migrada = linea({
      url: receptor.url(ruta),
      secretoCifrado: cifrarComoElCore(secreto),
      eventos: ['booking.confirmed'],
    });
    expect((await importar(archivo([migrada]))).codigo).toBe(0);

    // El dueño la ve con su API de siempre, con el secreto enmascarado
    const lista = await request(app.getHttpServer())
      .get('/flights/v1/webhooks')
      .set('Authorization', `Bearer ${identidad.firmar({ sub: migrada.idPropietario })}`)
      .expect(200);
    expect(lista.body).toEqual([
      {
        id: migrada.id,
        url: migrada.url,
        events: ['booking.confirmed'],
        secret: `****${secreto.slice(-4)}`,
      },
    ]);

    await datos.publicar(sobre('booking.confirmed', migrada.idPropietario)).expect(202);
    // Esta app usa el ClienteWebhookHttp real, sin doble
    await app.get(EntregaWebhooks).ejecutar();

    const [recibido] = receptor.de(ruta);
    expect(recibido).toBeDefined();
    const ts = recibido.cabeceras['x-webhook-timestamp'] as string;
    expect(recibido.cabeceras['x-webhook-signature']).toBe(
      `sha256=${createHmac('sha256', secreto).update(`${ts}.${recibido.cuerpo}`).digest('hex')}`,
    );
  });
});
