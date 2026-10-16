import { NestExpressApplication } from '@nestjs/platform-express';
import * as request from 'supertest';
import { crearApp } from './utils/crear-app';
import { sobre } from './utils/datos';
import { IdentidadFalsa, nuevaClave, OpcionesToken } from './utils/identidad-falsa';
import { LimitesReiniciables } from './utils/limites';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';

/**
 * La verificación de los tokens de identity_vuelos por su JWKS (el verificador de la fase 4b del
 * core): algoritmo fijo, kid, typ at+jwt, iss, aud, exp, enfriamiento y 503 AUTH_UNAVAILABLE sin
 * claves. Y los permisos: publicar exige events:publish con un token de cliente OAuth.
 */
const EVENTOS = '/internal/v1/events';
const WEBHOOKS = '/flights/v1/webhooks';
const DESAFIO_INVALIDO = (detalle: string) =>
  `Bearer realm="quinde-vuelos-api", error="invalid_token", error_description="${detalle}"`;

const reloj = new RelojDePrueba();
const limites = new LimitesReiniciables();
const logs: string[] = [];
/** Todo token armado en este archivo: ninguno puede aparecer en el log. */
const emitidos: string[] = [];
let identidad: IdentidadFalsa;

function token(opciones: OpcionesToken = {}): string {
  const firmado = identidad.firmar(opciones);
  emitidos.push(firmado);
  return firmado;
}

/** Un token del core para publicar, con lo que la prueba cambie. */
function publicador(opciones: OpcionesToken = {}): string {
  return token({ clientId: 'core-vuelos', scope: 'events:publish', ...opciones });
}

const claimsDe = (firmado: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(firmado.split('.')[1], 'base64url').toString());

/** Adelanta el reloj de la prueba en segundos (RelojDePrueba cuenta en minutos). */
const adelantar = (segundos: number) => reloj.adelantar(segundos / 60);

beforeAll(async () => {
  identidad = await IdentidadFalsa.iniciar(() => reloj.ahora());
});

afterAll(async () => {
  await identidad.detener();
});

describe('tokens de identity_vuelos', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const publicar = (firmado: string) =>
    http()
      .post(EVENTOS)
      .set('Authorization', `Bearer ${firmado}`)
      .send(sobre('booking.confirmed', '0b7c9f4e-3d2a-4b1c-8e5f-6a7b8c9d0e1f'));
  const listar = (firmado: string) =>
    http().get(WEBHOOKS).set('Authorization', `Bearer ${firmado}`);

  beforeAll(async () => {
    reloj.alPresente();
    app = await crearApp({ identidad, reloj, limites, logs });
  });

  afterAll(() => app.close());

  beforeEach(() => limites.reiniciar());

  describe('permisos', () => {
    it('el core (cliente OAuth con events:publish) publica: 202', async () => {
      await publicar(publicador()).expect(202);
    });

    it('sin token: 401 con WWW-Authenticate Bearer (sin error)', async () => {
      const respuesta = await http().post(EVENTOS).send({}).expect(401);
      esperarProblemDetails(respuesta);
      expect(respuesta.headers['www-authenticate']).toBe('Bearer realm="quinde-vuelos-api"');
    });

    it('una persona con flights:webhooks pero sin events:publish NO publica: 403 insufficient_scope', async () => {
      const respuesta = await publicar(token({ scope: 'flights:read flights:webhooks' })).expect(
        403,
      );
      esperarProblemDetails(respuesta);
      expect(respuesta.body.detail).toBe('Missing required scopes: events:publish');
      expect(respuesta.headers['www-authenticate']).toContain('error="insufficient_scope"');
    });

    it('una persona con events:publish tampoco publica: solo un cliente OAuth', async () => {
      const respuesta = await publicar(token({ scope: 'events:publish flights:webhooks' })).expect(
        403,
      );
      expect(respuesta.body.detail).toBe(
        'This operation requires an OAuth client token (client_credentials)',
      );
    });

    it('un cliente OAuth sin events:publish (con flights:webhooks) no publica', async () => {
      const respuesta = await publicar(publicador({ scope: 'flights:webhooks' })).expect(403);
      expect(respuesta.body.detail).toBe('Missing required scopes: events:publish');
    });

    it('al revés: el token del core (events:publish) no gestiona suscripciones', async () => {
      const respuesta = await listar(publicador()).expect(403);
      expect(respuesta.body.detail).toBe('Missing required scopes: flights:webhooks');
    });

    it('tolera 30 s de diferencia de reloj en exp, no más', async () => {
      await publicar(publicador({ venceEn: -20 })).expect(202);
      const respuesta = await publicar(publicador({ venceEn: -40 })).expect(401);
      expect(respuesta.headers['www-authenticate']).toBe(
        DESAFIO_INVALIDO('The access token expired'),
      );
    });

    it('el JWKS se bajó una sola vez para todas esas peticiones', () => {
      expect(identidad.descargas).toBe(1);
    });
  });

  describe('un token falso o manipulado es 401 invalid_token, nunca 202', () => {
    const alterarScope = (firmado: string, scope: string) => {
      const [cabecera, , firma] = firmado.split('.');
      const claims = { ...claimsDe(firmado), scope };
      return `${cabecera}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${firma}`;
    };
    const ahora = () => Math.floor(reloj.ahora().getTime() / 1000);

    const casos: Array<[string, () => string]> = [
      ['alg none', () => publicador({ sinFirma: true })],
      [
        'HS256 firmado con la clave pública (PEM) como secreto',
        () => publicador({ secretoHs256: identidad.claveActual.pem }),
      ],
      ['alg PS256 en la cabecera', () => publicador({ alg: 'PS256' })],
      ['un kid que el JWKS no tiene', () => publicador({ clave: nuevaClave() })],
      [
        'el kid de la clave real con la firma de otra',
        () => publicador({ clave: nuevaClave(), kid: identidad.claveActual.kid }),
      ],
      ['sin kid', () => publicador({ kid: null })],
      ['vencido', () => publicador({ venceEn: -3600 })],
      ['con nbf en el futuro', () => publicador({ claims: { nbf: ahora() + 3600 } })],
      ['iss ajeno', () => publicador({ iss: 'https://identity.otro.example' })],
      ['del emisor con barra final', () => publicador({ iss: `${identidad.emisor}/` })],
      ['aud ajeno', () => publicador({ aud: 'otra-api' })],
      ['sin exp', () => publicador({ sin: ['exp'] })],
      ['sin iat', () => publicador({ sin: ['iat'] })],
      ['sin jti', () => publicador({ sin: ['jti'] })],
      ['sin sub', () => publicador({ sin: ['sub'] })],
      ['sin iss', () => publicador({ sin: ['iss'] })],
      ['sin aud', () => publicador({ sin: ['aud'] })],
      ['typ distinto (JWT)', () => publicador({ typ: 'JWT' })],
      ['sin typ', () => publicador({ typ: null })],
      [
        'scope manipulado: una persona se agrega events:publish después de firmar',
        () => alterarScope(token({ scope: 'flights:webhooks' }), 'flights:webhooks events:publish'),
      ],
      [
        'client_id agregado después de firmar al token de una persona',
        () => {
          const firmado = token({ scope: 'events:publish' });
          const [cabecera, , firma] = firmado.split('.');
          const claims = { ...claimsDe(firmado), client_id: 'core-vuelos' };
          return `${cabecera}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${firma}`;
        },
      ],
      ['con un sub que no es uuid', () => publicador({ sub: 'core' })],
      ['con el scope en una lista', () => publicador({ scope: ['events:publish'] })],
      ['con un client_id que no es texto', () => publicador({ clientId: 42 })],
      ['que no es un JWT', () => 'no-es-un-jwt'],
    ];

    it.each(casos)('%s', async (_caso, crear) => {
      const firmado = crear();
      const respuesta = await publicar(firmado);

      expect(respuesta.status).toBe(401);
      esperarProblemDetails(respuesta);
      expect(respuesta.headers['www-authenticate']).toMatch(
        /^Bearer realm=.*error="invalid_token"/,
      );
      expect(JSON.stringify(respuesta.body)).not.toContain(firmado.split('.')[2] || firmado);
    });

    it('el log dice el motivo y el kid de cada rechazo', () => {
      const texto = logs.join('\n');
      for (const motivo of [
        'alg-no-permitido',
        'kid-desconocido',
        'firma-invalida',
        'iss-check_failed',
        'aud-check_failed',
        'exp-missing',
        'typ-check_failed',
        'sub-no-uuid',
        'scope-no-texto',
        'client_id-invalido',
      ]) {
        expect(texto).toContain(`Token rechazado: ${motivo} (kid `);
      }
      expect(texto).toContain(`(kid ${identidad.claveActual.kid})`);
    });
  });
});

describe('el JWKS caído, lento o rotado', () => {
  let app: NestExpressApplication | undefined;
  const publicar = (firmado: string) =>
    request(app!.getHttpServer())
      .post(EVENTOS)
      .set('Authorization', `Bearer ${firmado}`)
      .send(sobre('booking.confirmed', '0b7c9f4e-3d2a-4b1c-8e5f-6a7b8c9d0e1f'));

  /** Cada caso, con una app nueva: sin copia del JWKS. */
  beforeEach(async () => {
    await identidad.reiniciar();
    reloj.alPresente();
    limites.reiniciar();
    app = await crearApp({ identidad, reloj, limites, logs });
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function esperar503(respuesta: request.Response) {
    expect(respuesta.status).toBe(503);
    esperarProblemDetails(respuesta);
    expect(respuesta.body.code).toBe('AUTH_UNAVAILABLE');
    expect(Number(respuesta.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(respuesta.headers['retry-after'])).toBeLessThanOrEqual(10);
  }

  it('JWKS caído CON copia vigente: no se nota (202)', async () => {
    await publicar(publicador()).expect(202);
    await identidad.caer();

    for (let i = 0; i < 20; i++) await publicar(publicador()).expect(202);
    adelantar(240);
    await publicar(publicador()).expect(202);
    expect(identidad.descargas).toBe(1);
  });

  it('JWKS caído SIN copia: 503 AUTH_UNAVAILABLE con Retry-After, nunca 202 ni 401', async () => {
    await identidad.caer();

    for (const firmado of [
      publicador(),
      publicador({ venceEn: -3600 }),
      publicador({ clave: nuevaClave() }),
    ]) {
      esperar503(await publicar(firmado));
    }
    // Lo que ni siquiera es un JWT, o no trae kid, se rechaza sin pedir claves: sigue en 401
    expect((await publicar('no-es-un-jwt')).status).toBe(401);
    expect((await publicar(publicador({ kid: null }))).status).toBe(401);
    expect(logs.join('\n')).toContain(
      'No se pudo bajar el JWKS (ECONNREFUSED); no hay una copia vigente',
    );
  });

  it('una copia vencida no se usa: sin servicio es 503 hasta que vuelve', async () => {
    await publicar(publicador()).expect(202);
    await identidad.caer();
    adelantar(301);

    esperar503(await publicar(publicador()));

    await identidad.levantar();
    adelantar(11);
    await publicar(publicador()).expect(202);
  });

  it('un JWKS que responde 500 no se pide en cada petición: se espera el enfriamiento', async () => {
    identidad.fallar();
    for (let i = 0; i < 20; i++) esperar503(await publicar(publicador()));
    expect(identidad.descargas).toBe(1);

    adelantar(11);
    esperar503(await publicar(publicador()));
    expect(identidad.descargas).toBe(2);

    await identidad.levantar();
    adelantar(11);
    await publicar(publicador()).expect(202);
    expect(identidad.descargas).toBe(3);
  });

  it('un JWKS lento se corta a los 3 s con 503, no deja la petición colgada', async () => {
    identidad.tardar(6000);
    const antes = Date.now();
    esperar503(await publicar(publicador()));
    const demora = Date.now() - antes;
    expect(demora).toBeGreaterThanOrEqual(2900);
    expect(demora).toBeLessThan(5000);
  });

  it('rotación: la clave nueva se descubre sola y la quitada deja de valer al vencer la copia', async () => {
    const vieja = identidad.claveActual;
    const conVieja = publicador();
    await publicar(conVieja).expect(202);

    identidad.rotar();
    adelantar(11);
    await publicar(publicador()).expect(202);
    await publicar(conVieja).expect(202);
    expect(identidad.descargas).toBe(2);

    identidad.quitar(vieja);
    adelantar(360);
    expect((await publicar(conVieja)).status).toBe(401);
    await publicar(publicador()).expect(202);
  });

  it('100 kid inventados provocan a lo sumo una descarga más', async () => {
    await publicar(publicador()).expect(202);
    adelantar(11);

    for (let i = 0; i < 100; i++) {
      expect((await publicar(publicador({ kid: `kid-inventado-${i}` }))).status).toBe(401);
    }
    expect(identidad.descargas).toBeLessThanOrEqual(2);
  });

  it('un JWKS sin claves no deja pasar a nadie: 401', async () => {
    const firmado = publicador();
    identidad.vaciar();
    expect((await publicar(firmado)).status).toBe(401);
  });
});

describe('sin identidad falsa (el JWKS_URL del entorno, un puerto cerrado)', () => {
  it('el verificador que arma AutenticacionModule falla cerrado: 503, nunca deja pasar', async () => {
    await identidad.reiniciar();
    const app = await crearApp({ reloj, limites });
    try {
      const respuesta = await request(app.getHttpServer())
        .get(WEBHOOKS)
        .set('Authorization', `Bearer ${token()}`);
      expect(respuesta.status).toBe(503);
      expect(respuesta.body.code).toBe('AUTH_UNAVAILABLE');
    } finally {
      await app.close();
    }
  });
});

describe('nada sensible en el log', () => {
  it('ningún token, firma ni clave del JWKS aparece en el log', () => {
    expect(emitidos.length).toBeGreaterThan(100);
    const texto = logs.join('\n');
    expect(texto).toContain('JWKS descargado: 1 claves (kid ');
    const sensibles = [
      ...emitidos.flatMap((t) => [t, t.split('.')[2]].filter((s) => s && s.length > 20)),
      ...identidad.publicadas.map((c) => c.jwk.n),
      'BEGIN PUBLIC KEY',
    ];
    for (const sensible of sensibles) expect(texto).not.toContain(sensible);
  });
});
