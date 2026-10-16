import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compararCarpetas } from '../src/cli/eventos-breaking';
import { CifradoSecreto } from '../src/modules/compartido/cifrado-secreto';
import {
  direccionProhibida,
  motivoDestinoInvalido,
} from '../src/modules/compartido/destino-permitido';
import { EVENTOS_WEBHOOK, enmascarar } from '../src/modules/compartido/eventos-webhook';
import { firmar, firmaValida } from '../src/modules/compartido/firma-webhook';
import { ClienteWebhookHttp, REGLAS_ENVIO } from '../src/modules/entrega/cliente-webhook-http';
import { proximoIntentoTras, REGLAS_ENTREGA } from '../src/modules/entrega/entrega-webhooks';
import {
  compararEsquemas,
  Esquema,
  problemasDeArchivo,
} from '../src/modules/evento/contrato/compatibilidad';
import {
  CARPETA_ESQUEMAS,
  EsquemasInvalidosError,
  RegistroEsquemas,
} from '../src/modules/evento/contrato/registro-esquemas';
import { validarEntorno } from '../src/config/entorno';
import { ejemplo } from './utils/datos';

const config = (valores: Record<string, string>) =>
  ({ get: (k: string) => valores[k], getOrThrow: (k: string) => valores[k] }) as ConfigService;

describe('firma de las entregas', () => {
  it('es sha256= más el HMAC-SHA256 en hexadecimal de "timestamp.cuerpo"', () => {
    const esperado = createHmac('sha256', 'secreto').update('1700000000.{"a":1}').digest('hex');
    expect(firmar('secreto', 1700000000, '{"a":1}')).toBe(`sha256=${esperado}`);
  });

  it('cambia con el secreto, el timestamp o el cuerpo; es determinista', () => {
    const base = firmar('s', 1, 'c');
    expect(firmar('s', 1, 'c')).toBe(base);
    expect(firmar('t', 1, 'c')).not.toBe(base);
    expect(firmar('s', 2, 'c')).not.toBe(base);
    expect(firmar('s', 1, 'd')).not.toBe(base);
  });

  it('firmaValida acepta la correcta y rechaza cualquier otra, también de otro largo', () => {
    const firma = firmar('s', 1, 'c');
    expect(firmaValida('s', 1, 'c', firma)).toBe(true);
    expect(firmaValida('s', 1, 'c', firma.slice(0, -1))).toBe(false);
    expect(firmaValida('s', 1, 'c', `${firma}0`)).toBe(false);
    expect(firmaValida('s', 1, 'd', firma)).toBe(false);
  });
});

describe('espera entre reintentos', () => {
  const ahora = new Date('2026-10-16T12:00:00.000Z');
  const despues = (minutos: number) => new Date(ahora.getTime() + minutos * 60_000);

  it('1 min, 5 min, 30 min y 2 h tras los intentos 1 a 4; 5 intentos en total', () => {
    expect([1, 2, 3, 4].map((i) => proximoIntentoTras(i, ahora))).toEqual([
      despues(1),
      despues(5),
      despues(30),
      despues(120),
    ]);
    expect(REGLAS_ENTREGA.maximoIntentos).toBe(5);
  });

  it('tras el quinto intento ya no hay otro', () => {
    expect(proximoIntentoTras(5, ahora)).toBeNull();
  });

  it('las demás reglas del core: 10 s, arrendamiento de 2 min, 10 fallidas, plazo de 5 s', () => {
    expect(REGLAS_ENTREGA.intervaloPorDefectoSegundos).toBe(10);
    expect(REGLAS_ENTREGA.arrendamientoSegundos).toBe(120);
    expect(REGLAS_ENTREGA.fallidasSeguidasParaBaja).toBe(10);
    expect(REGLAS_ENVIO.tiempoMaximoMs).toBe(5000);
  });
});

describe('secreto de la suscripción', () => {
  const CLAVE = 'una-clave-de-pruebas-de-al-menos-32-caracteres';
  const cifrado = new CifradoSecreto(config({ WEBHOOK_SECRET_KEY: CLAVE }));

  /**
   * El formato del core escrito aquí desde cero (CifradoSecreto de backend_vuelos): AES-256-GCM,
   * clave HKDF-SHA256 de WEBHOOK_SECRET_KEY con sal "quinde-vuelos" e info "webhook-secreto",
   * y `v1.` + base64url(nonce de 12 | etiqueta de 16 | cifrado). Si alguien cambia la sal, la
   * info o el formato, los secretos del core dejan de migrarse y esta prueba falla.
   */
  const claveDelCore = (clave: string) =>
    Buffer.from(hkdfSync('sha256', clave, 'quinde-vuelos', 'webhook-secreto', 32));
  const cifrarComoElCore = (secreto: string, clave = CLAVE) => {
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', claveDelCore(clave), nonce);
    const cuerpo = Buffer.concat([c.update(secreto, 'utf8'), c.final()]);
    return `v1.${Buffer.concat([nonce, c.getAuthTag(), cuerpo]).toString('base64url')}`;
  };
  const descifrarComoElCore = (guardado: string, clave = CLAVE) => {
    const bytes = Buffer.from(guardado.slice(3), 'base64url');
    const d = createDecipheriv('aes-256-gcm', claveDelCore(clave), bytes.subarray(0, 12));
    d.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([d.update(bytes.subarray(28)), d.final()]).toString('utf8');
  };

  it('enmascara con **** y los últimos 4 caracteres', () => {
    expect(enmascarar('un-secreto-compartido-0001')).toBe('****0001');
  });

  it('cifra de forma reversible y nunca deja el secreto a la vista', () => {
    const guardado = cifrado.cifrar('un-secreto-compartido-0001');
    expect(guardado).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(guardado).not.toContain('secreto');
    expect(cifrado.descifrar(guardado)).toBe('un-secreto-compartido-0001');
  });

  it('el mismo secreto cifrado dos veces da textos distintos (nonce al azar)', () => {
    expect(cifrado.cifrar('abc')).not.toBe(cifrado.cifrar('abc'));
  });

  it('descifra un secreto cifrado con el formato del core (la migración no los toca)', () => {
    expect(cifrado.descifrar(cifrarComoElCore('secreto-del-core-0001'))).toBe(
      'secreto-del-core-0001',
    );
  });

  it('lo que cifra este servicio lo descifra el formato del core (vuelta atrás posible)', () => {
    expect(descifrarComoElCore(cifrado.cifrar('secreto-del-notifier-1'))).toBe(
      'secreto-del-notifier-1',
    );
  });

  it('un valor alterado, de otra versión o cifrado con otra clave no se descifra', () => {
    const guardado = cifrado.cifrar('secreto');
    const alterado = `${guardado.slice(0, -2)}${guardado.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(() => cifrado.descifrar(alterado)).toThrow();
    expect(() => cifrado.descifrar(guardado.replace('v1.', 'v2.'))).toThrow();
    expect(() => cifrado.descifrar(cifrarComoElCore('secreto', `${CLAVE}-otra`))).toThrow();
  });

  it('el error al descifrar no trae el valor guardado', () => {
    const guardado = cifrado.cifrar('secreto').replace('v1.', 'v9.');
    try {
      cifrado.descifrar(guardado);
      throw new Error('no falló');
    } catch (error) {
      expect((error as Error).message).not.toContain(guardado.slice(3));
    }
  });
});

describe('SSRF: qué direcciones se aceptan', () => {
  it.each([
    '10.0.0.1',
    '172.16.5.4',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '240.0.0.1',
    'fc00::1',
    'fe80::1',
    '::',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
  ])('%s está prohibida siempre', (ip) => {
    expect(direccionProhibida(ip, { produccion: false })).toBe(true);
    expect(direccionProhibida(ip, { produccion: true })).toBe(true);
  });

  it('loopback solo fuera de producción', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
      expect(direccionProhibida(ip, { produccion: false })).toBe(false);
      expect(direccionProhibida(ip, { produccion: true })).toBe(true);
    }
  });

  it('una IP pública se acepta', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::6810:84e5']) {
      expect(direccionProhibida(ip, { produccion: true })).toBe(false);
    }
  });

  it('en producción: solo https, sin loopback ni credenciales', async () => {
    const prod = { produccion: true };
    expect(await motivoDestinoInvalido('http://8.8.8.8/hook', prod)).toBe('must use https');
    expect(await motivoDestinoInvalido('http://localhost/hook', prod)).toBe('must use https');
    expect(await motivoDestinoInvalido('https://localhost/hook', prod)).toBe(
      'host resolves to a network that is not allowed',
    );
    expect(await motivoDestinoInvalido('https://127.0.0.1/hook', prod)).toBe(
      'host resolves to a network that is not allowed',
    );
    expect(await motivoDestinoInvalido('https://u:p@8.8.8.8/hook', prod)).toBe(
      'must not include credentials',
    );
    expect(await motivoDestinoInvalido('https://8.8.8.8/hook', prod)).toBeNull();
  });

  it('fuera de producción: http solo hacia loopback', async () => {
    const dev = { produccion: false };
    expect(await motivoDestinoInvalido('http://localhost:4010/hook', dev)).toBeNull();
    expect(await motivoDestinoInvalido('http://127.0.0.1:4010/hook', dev)).toBeNull();
    expect(await motivoDestinoInvalido('http://8.8.8.8/hook', dev)).toBe('must use https');
    expect(await motivoDestinoInvalido('http://10.0.0.1/hook', dev)).toBe(
      'host resolves to a network that is not allowed',
    );
  });
});

describe('ClienteWebhookHttp', () => {
  let servidor: Server;
  let puerto: number;
  let recibidos: Array<{ metodo: string; cabeceras: Record<string, unknown>; cuerpo: string }>;
  let responder: (r: import('node:http').ServerResponse) => void;

  beforeAll(async () => {
    servidor = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (p: Buffer) => partes.push(p));
      req.on('end', () => {
        recibidos.push({
          metodo: req.method ?? '',
          cabeceras: req.headers,
          cuerpo: Buffer.concat(partes).toString(),
        });
        responder(res);
      });
    });
    await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
    puerto = (servidor.address() as AddressInfo).port;
  });
  beforeEach(() => {
    recibidos = [];
    responder = (res) => res.writeHead(204).end();
  });
  afterAll(async () => {
    servidor.closeAllConnections();
    await new Promise((r) => servidor.close(r));
  });

  const desarrollo = new ClienteWebhookHttp(config({ NODE_ENV: 'test' }));
  const produccion = new ClienteWebhookHttp(config({ NODE_ENV: 'production' }));
  const peticion = (url: string) => ({
    url,
    cabeceras: { 'Content-Type': 'application/json', 'X-Webhook-Id': 'abc' },
    cuerpo: '{"a":1}',
  });

  it('hace un POST con las cabeceras y el cuerpo tal cual, y devuelve el código', async () => {
    const resultado = await desarrollo.enviar(peticion(`http://127.0.0.1:${puerto}/x`));
    expect(resultado).toEqual({ codigoHttp: 204, error: null });
    expect(recibidos).toEqual([
      expect.objectContaining({
        metodo: 'POST',
        cuerpo: '{"a":1}',
        cabeceras: expect.objectContaining({ 'x-webhook-id': 'abc' }),
      }),
    ]);
  });

  it('no sigue redirecciones: una 302 es la respuesta y el destino nunca se visita', async () => {
    responder = (res) =>
      res.writeHead(302, { Location: `http://127.0.0.1:${puerto}/destino` }).end();
    const resultado = await desarrollo.enviar(peticion(`http://127.0.0.1:${puerto}/x`));
    expect(resultado).toEqual({ codigoHttp: 302, error: null });
    expect(recibidos).toHaveLength(1);
  });

  it('un puerto cerrado es ECONNREFUSED, sin host ni puerto en el error', async () => {
    const resultado = await desarrollo.enviar(peticion('http://127.0.0.1:9/x'));
    expect(resultado).toEqual({ codigoHttp: null, error: 'ECONNREFUSED' });
  });

  it('en producción tampoco el loopback, ni por IP ni por nombre (localhost resuelve a 127.0.0.1)', async () => {
    expect(await produccion.enviar(peticion(`https://127.0.0.1:${puerto}/x`))).toEqual({
      codigoHttp: null,
      error: 'DESTINATION_NOT_ALLOWED',
    });
    expect(await produccion.enviar(peticion(`https://localhost:${puerto}/x`))).toEqual({
      codigoHttp: null,
      error: 'DESTINATION_NOT_ALLOWED',
    });
    expect(recibidos).toEqual([]);
  });

  it('en producción http no se usa; una URL ilegible es INVALID_URL', async () => {
    expect(await produccion.enviar(peticion(`http://127.0.0.1:${puerto}/x`))).toEqual({
      codigoHttp: null,
      error: 'INSECURE_URL',
    });
    expect(await desarrollo.enviar(peticion('no es una url'))).toEqual({
      codigoHttp: null,
      error: 'INVALID_URL',
    });
  });
});

describe('variables de entorno', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/notifier_db?schema=notificaciones',
    PORT: '3002',
    NODE_ENV: 'development',
    JWT_ISSUER: 'https://identity.quinde.example',
    JWT_AUDIENCE: 'quinde-vuelos-api',
    WEBHOOK_SECRET_KEY: 'k'.repeat(40),
  };
  const error = (cambios: Record<string, unknown>) => {
    try {
      validarEntorno({ ...base, ...cambios });
    } catch (e) {
      return (e as Error).message;
    }
    return '';
  };

  it('con las obligatorias, arranca', () => {
    expect(error({})).toBe('');
  });

  it.each(['DATABASE_URL', 'PORT', 'NODE_ENV', 'JWT_ISSUER', 'JWT_AUDIENCE', 'WEBHOOK_SECRET_KEY'])(
    'sin %s no arranca y el error la nombra',
    (variable) => {
      expect(error({ [variable]: undefined })).toContain(variable);
    },
  );

  it('WEBHOOK_SECRET_KEY de menos de 32 caracteres no sirve, y el error no repite la clave', () => {
    const mensaje = error({ WEBHOOK_SECRET_KEY: 'clave-corta-que-no-sirve' });
    expect(mensaje).toContain('WEBHOOK_SECRET_KEY debe tener al menos 32 caracteres');
    expect(mensaje).not.toContain('clave-corta-que-no-sirve');
  });

  it('JWT_ISSUER es un origen sin ruta; https en producción', () => {
    expect(error({ JWT_ISSUER: 'https://identity.quinde.example/' })).toContain('JWT_ISSUER');
    expect(error({ JWT_ISSUER: 'https://identity.quinde.example/x' })).toContain('JWT_ISSUER');
    expect(
      error({ JWT_ISSUER: 'http://identity.quinde.example', NODE_ENV: 'production' }),
    ).toContain('JWT_ISSUER');
    expect(error({ JWT_ISSUER: 'http://localhost:3001' })).toBe('');
  });

  it('el proceso de entrega: true/false y de 5 a 3600 segundos', () => {
    expect(error({ NOTIFIER_DELIVERY_JOB_ENABLED: 'si' })).toContain(
      'NOTIFIER_DELIVERY_JOB_ENABLED',
    );
    expect(error({ NOTIFIER_DELIVERY_JOB_ENABLED: 'false' })).toBe('');
    expect(error({ NOTIFIER_DELIVERY_JOB_INTERVAL_SECONDS: '4' })).toContain(
      'NOTIFIER_DELIVERY_JOB_INTERVAL_SECONDS',
    );
    expect(error({ NOTIFIER_DELIVERY_JOB_INTERVAL_SECONDS: '10' })).toBe('');
  });

  it('EVENTS_RATE_LIMIT_MAX entre 1 y 100000; CORS_ORIGINS sin "*"; TRUST_PROXY sin true', () => {
    expect(error({ EVENTS_RATE_LIMIT_MAX: '0' })).toContain('EVENTS_RATE_LIMIT_MAX');
    expect(error({ CORS_ORIGINS: '*' })).toContain('CORS_ORIGINS');
    expect(error({ TRUST_PROXY: 'true' })).toContain('TRUST_PROXY');
  });

  it('una variable vacía cuenta como no definida', () => {
    expect(error({ JWKS_URL: '' })).toBe('');
    expect(error({ WEBHOOK_SECRET_KEY: '' })).toContain('WEBHOOK_SECRET_KEY es obligatoria');
  });
});

describe('esquemas de eventos', () => {
  const leer = (nombre: string) =>
    JSON.parse(readFileSync(join(CARPETA_ESQUEMAS, nombre), 'utf8')) as Esquema;
  const registro = new RegistroEsquemas();

  it('los 12 tipos tienen su v1, y el ejemplo de cada esquema es válido', () => {
    for (const tipo of EVENTOS_WEBHOOK) {
      expect(registro.versionesDe(tipo)).toEqual(['1.0']);
      expect(registro.validar(ejemplo(tipo)).valido).toBe(true);
    }
  });

  it('cada archivo cumple las reglas de forma', () => {
    for (const tipo of EVENTOS_WEBHOOK) {
      expect(problemasDeArchivo(`${tipo}.v1.json`, leer(`${tipo}.v1.json`))).toEqual([]);
    }
  });

  describe('compatibilidad (npm run eventos:breaking)', () => {
    const base = () =>
      new Map<string, Esquema>([
        ['booking.cancelled.v1.json', leer('booking.cancelled.v1.json')],
        ['hold.expired.v1.json', leer('hold.expired.v1.json')],
      ]);
    const cambiar = (mutar: (e: Esquema & Record<string, never>) => void) => {
      const actuales = base();
      const esquema = structuredClone(actuales.get('booking.cancelled.v1.json') as Esquema);
      mutar(esquema as never);
      actuales.set('booking.cancelled.v1.json', esquema);
      return compararCarpetas(base(), actuales);
    };
    const data = (e: Esquema) =>
      (e as { properties: { data: { properties: Record<string, Esquema>; required: string[] } } })
        .properties.data;

    it.each<[string, (e: Esquema) => void]>([
      [
        'quitar un campo',
        (e) => {
          delete data(e).properties.pnr;
          data(e).required = ['bookingId', 'status'];
        },
      ],
      [
        'renombrar un campo',
        (e) => {
          data(e).properties.localizador = data(e).properties.pnr;
          delete data(e).properties.pnr;
          data(e).required = ['bookingId', 'localizador', 'status'];
        },
      ],
      ['volver obligatorio un campo opcional', (e) => void data(e).required.push('refundAmount')],
      [
        'dejar de exigir un campo obligatorio',
        (e) => {
          data(e).required = ['bookingId', 'status'];
        },
      ],
      [
        'agregar un campo obligatorio',
        (e) => {
          data(e).properties.nuevo = { type: 'string' };
          data(e).required.push('nuevo');
        },
      ],
      [
        'cambiar el tipo de un campo',
        (e) => {
          data(e).properties.pnr = { type: 'number' };
        },
      ],
      [
        'cambiar el patrón de un campo',
        (e) => {
          (data(e).properties.pnr as { pattern: string }).pattern = '^[A-Z]{6}$';
        },
      ],
      [
        'quitar un valor de un enum',
        (e) => {
          (data(e).properties.status as { enum: string[] }).enum.pop();
        },
      ],
      [
        'permitir campos de más en data',
        (e) => {
          (data(e) as unknown as { additionalProperties: boolean }).additionalProperties = true;
        },
      ],
      [
        'poner una versión 2.0 en el archivo v1',
        (e) => {
          (
            e as { properties: { schemaVersion: { enum: string[] } } }
          ).properties.schemaVersion.enum.push('2.0');
        },
      ],
    ])('incompatible: %s', (_caso, mutar) => {
      expect(cambiar(mutar).incompatible).toBe(true);
    });

    it.each<[string, (e: Esquema) => void]>([
      [
        'agregar un campo opcional',
        (e) => {
          data(e).properties.nota = { type: 'string' };
        },
      ],
      [
        'agregar la versión 1.1',
        (e) => {
          (
            e as { properties: { schemaVersion: { enum: string[] } } }
          ).properties.schemaVersion.enum.push('1.1');
        },
      ],
      [
        'agregar un valor a un enum',
        (e) => {
          (data(e).properties.status as { enum: string[] }).enum.push('ARCHIVED');
        },
      ],
      [
        'cambiar la descripción',
        (e) => {
          (e as { description: string }).description = 'otra';
        },
      ],
    ])('compatible: %s', (_caso, mutar) => {
      expect(cambiar(mutar).incompatible).toBe(false);
    });

    it('borrar el archivo de una versión es incompatible; uno nuevo (v2) es compatible', () => {
      const sinHold = base();
      sinHold.delete('hold.expired.v1.json');
      expect(compararCarpetas(base(), sinHold).incompatible).toBe(true);

      const conV2 = base();
      const v2 = structuredClone(leer('hold.expired.v1.json')) as {
        $id: string;
        properties: { schemaVersion: { enum: string[] } };
      };
      v2.$id = v2.$id.replace('.v1.json', '.v2.json');
      v2.properties.schemaVersion.enum = ['2.0'];
      conV2.set('hold.expired.v2.json', v2 as unknown as Esquema);
      expect(compararCarpetas(base(), conV2).incompatible).toBe(false);
    });

    it('un archivo mal formado no pasa: tipo que no es de los 12, eventType distinto del nombre', () => {
      const actuales = base();
      actuales.set('booking.created.v1.json', leer('booking.confirmed.v1.json'));
      expect(compararCarpetas(base(), actuales).problemas.length).toBeGreaterThan(0);
    });

    it('compararEsquemas sin cambios no devuelve nada', () => {
      const esquema = leer('flight.cancelled.v1.json');
      expect(compararEsquemas(esquema, structuredClone(esquema))).toEqual([]);
    });
  });

  describe('al arrancar', () => {
    let carpeta: string;
    beforeEach(() => {
      carpeta = mkdtempSync(join(tmpdir(), 'esquemas-'));
      cpSync(CARPETA_ESQUEMAS, carpeta, { recursive: true });
    });
    afterEach(() => rmSync(carpeta, { recursive: true, force: true }));

    it('sin el v1 de un tipo, el registro no se arma (el servicio no levanta)', () => {
      unlinkSync(join(carpeta, 'hold.expired.v1.json'));
      expect(() => new RegistroEsquemas(carpeta)).toThrow(EsquemasInvalidosError);
      expect(() => new RegistroEsquemas(carpeta)).toThrow(/falta hold.expired.v1.json/);
    });

    it('con un archivo mal formado tampoco', () => {
      writeFileSync(join(carpeta, 'booking.confirmed.v2.json'), '{"no":"es un sobre"}');
      expect(() => new RegistroEsquemas(carpeta)).toThrow(EsquemasInvalidosError);
    });

    it('ni con una v2 copiada de la v1 que conserva su $id', () => {
      const v2 = JSON.parse(readFileSync(join(carpeta, 'hold.expired.v1.json'), 'utf8'));
      v2.properties.schemaVersion.enum = ['2.0'];
      writeFileSync(join(carpeta, 'hold.expired.v2.json'), JSON.stringify(v2));
      expect(() => new RegistroEsquemas(carpeta)).toThrow(/el \$id debe terminar en/);
    });

    it('una v2 bien formada convive con la v1 y se elige por el mayor de schemaVersion', () => {
      const v2 = JSON.parse(readFileSync(join(carpeta, 'hold.expired.v1.json'), 'utf8'));
      v2.$id = v2.$id.replace('.v1.json', '.v2.json');
      v2.properties.schemaVersion.enum = ['2.0'];
      v2.properties.data.properties.reason = { type: 'string', enum: ['TIMEOUT'] };
      v2.properties.data.required.push('reason');
      writeFileSync(join(carpeta, 'hold.expired.v2.json'), JSON.stringify(v2));
      const conV2 = new RegistroEsquemas(carpeta);
      expect(conV2.versionesDe('hold.expired')).toEqual(['1.0', '2.0']);
      const v1 = ejemplo('hold.expired');
      expect(conV2.validar(v1).valido).toBe(true);
      expect(conV2.validar({ ...v1, schemaVersion: '2.0' }).valido).toBe(false);
      expect(
        conV2.validar({
          ...v1,
          schemaVersion: '2.0',
          data: { ...(v1.data as object), reason: 'TIMEOUT' },
        }).valido,
      ).toBe(true);
    });
  });

  it('contracts/asyncapi.yaml nombra los 12 mensajes y cada esquema que referencia existe', () => {
    const asyncapi = readFileSync(join(CARPETA_ESQUEMAS, '..', 'asyncapi.yaml'), 'utf8');
    const referencias = [...asyncapi.matchAll(/\$ref: '\.\/events\/([^']+)'/g)].map((m) => m[1]);
    expect(referencias.sort()).toEqual(EVENTOS_WEBHOOK.map((t) => `${t}.v1.json`).sort());
    for (const archivo of referencias) expect(() => leer(archivo)).not.toThrow();
  });
});
