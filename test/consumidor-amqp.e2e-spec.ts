import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Reloj } from '../src/common/reloj';
import { validarEntorno } from '../src/config/entorno';
import {
  CanalAmqp,
  ConexionAmqp,
  FabricaAmqp,
  MensajeAmqp,
  OpcionesPublicacionAmqp,
} from '../src/modules/consumidor/canal-amqp';
import { conLatido } from '../src/modules/consumidor/fabrica-amqplib';
import { ConsumidorAmqp } from '../src/modules/consumidor/consumidor-amqp';
import { ProcesadorMensajes } from '../src/modules/consumidor/procesador-mensajes';
import { REGLAS_AMQP, TOPOLOGIA } from '../src/modules/consumidor/topologia';
import { RegistroEsquemas } from '../src/modules/evento/contrato/registro-esquemas';
import { PublicacionEventos } from '../src/modules/evento/evento.service';
import { Observabilidad } from '../src/observabilidad/observabilidad';
import { traceparentActivo } from '../src/observabilidad/contexto-traza';
import { sobre } from './utils/datos';

/**
 * El consumidor de RabbitMQ sin broker: un canal falso que anota cada ack y cada publicación, y la
 * PublicacionEventos REAL (validación e idempotencia incluidas) con el repositorio y la base en
 * doble, así que no necesita PostgreSQL.
 */

interface Publicado {
  cola: string;
  contenido: Buffer;
  opciones: OpcionesPublicacionAmqp;
}

class CanalFalso implements CanalAmqp {
  readonly acks: MensajeAmqp[] = [];
  readonly publicados: Publicado[] = [];
  readonly exchanges: Array<{ nombre: string; tipo: string }> = [];
  readonly colas = new Map<string, Record<string, unknown> | undefined>();
  readonly ligas: Array<[string, string, string]> = [];
  prefetchPedido = 0;
  alRecibir: ((m: MensajeAmqp | null) => void) | undefined;
  falloAlPublicar = false;

  async declararExchange(nombre: string, tipo: 'topic') {
    this.exchanges.push({ nombre, tipo });
  }
  async declararCola(nombre: string, argumentos?: Record<string, unknown>) {
    this.colas.set(nombre, argumentos);
  }
  async ligarCola(cola: string, exchange: string, patron: string) {
    this.ligas.push([cola, exchange, patron]);
  }
  async prefetch(cantidad: number) {
    this.prefetchPedido = cantidad;
  }
  async consumir(_cola: string, alRecibir: (m: MensajeAmqp | null) => void) {
    this.alRecibir = alRecibir;
  }
  ack(mensaje: MensajeAmqp) {
    this.acks.push(mensaje);
  }
  async publicarEnCola(cola: string, contenido: Buffer, opciones: OpcionesPublicacionAmqp) {
    if (this.falloAlPublicar) throw new Error('canal cerrado');
    this.publicados.push({ cola, contenido, opciones });
  }
  en(cola: string) {
    return this.publicados.filter((p) => p.cola === cola);
  }
}

function mensaje(
  cuerpo: unknown,
  headers: Record<string, unknown> = {},
  props: Record<string, unknown> = {},
): MensajeAmqp {
  const texto = typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo);
  return {
    content: Buffer.from(texto),
    fields: { routingKey: 'booking.confirmed', deliveryTag: 1 },
    properties: { headers, messageId: randomUUID(), ...props },
  } as unknown as MensajeAmqp;
}

const config = (valores: Record<string, unknown>) =>
  ({ get: (k: string) => valores[k], getOrThrow: (k: string) => valores[k] }) as ConfigService;

/** La PublicacionEventos real con un repositorio que simula "nuevo", "repetido" o "otro contenido". */
function servicio(modo: 'nuevo' | 'repetido-igual' | 'repetido-distinto' | 'base-caida') {
  const guardados: Array<{ publicadoPor: string; huella: string; traceparent: string | null }> = [];
  let huellaGuardada = '';
  const repositorio = {
    guardar: jest.fn(async (_tx: unknown, e: { publicadoPor: string; huella: string }) => {
      guardados.push(e as never);
      huellaGuardada = e.huella;
      return modo === 'nuevo';
    }),
    existente: jest.fn(async () => ({
      huella: modo === 'repetido-igual' ? huellaGuardada : 'otra-huella',
      entregas: 2,
    })),
    repartir: jest.fn(async () => 1),
  };
  const prisma = {
    transaccion: async (trabajo: (tx: unknown) => Promise<unknown>) => {
      if (modo === 'base-caida') throw new Error('connection refused');
      return trabajo({});
    },
  };
  const observabilidad = new Observabilidad(config({ NODE_ENV: 'test', METRICS_PORT: 0 }));
  const traductores = { v1: () => ({}), v2: () => ({}) };
  const publicacion = new PublicacionEventos(
    new RegistroEsquemas(),
    repositorio as never,
    prisma as never,
    new Reloj(),
    observabilidad,
    traductores as never,
  );
  return { publicacion, repositorio, guardados, observabilidad };
}

function procesadorCon(modo: Parameters<typeof servicio>[0]) {
  const s = servicio(modo);
  const procesador = new ProcesadorMensajes(s.publicacion, s.observabilidad, new Reloj());
  const contador = (nombre: string) =>
    s.observabilidad.metricas.registro.getSingleMetricAsString(nombre);
  return { ...s, procesador, contador };
}

describe('ProcesadorMensajes', () => {
  let canal: CanalFalso;
  beforeEach(() => {
    canal = new CanalFalso();
  });

  it('acepta un evento nuevo: ack, sin DLQ ni reintento, con publicado_por amqp:gateway', async () => {
    const { procesador, guardados, contador } = procesadorCon('nuevo');
    const m = mensaje(sobre('booking.confirmed', randomUUID()));
    await procesador.procesar(canal, m);
    expect(canal.acks).toEqual([m]);
    expect(canal.publicados).toHaveLength(0);
    expect(guardados[0].publicadoPor).toBe('amqp:gateway');
    expect(await contador('notifier_amqp_consumed_total')).toContain(
      'notifier_amqp_consumed_total 1',
    );
    expect(await contador('notifier_amqp_results_total')).toContain('result="accepted"} 1');
  });

  it('un duplicado con el mismo contenido: ack y cuenta como duplicate', async () => {
    const { procesador, contador } = procesadorCon('repetido-igual');
    const m = mensaje(sobre('booking.confirmed', randomUUID()));
    await procesador.procesar(canal, m);
    expect(canal.acks).toEqual([m]);
    expect(canal.publicados).toHaveLength(0);
    expect(await contador('notifier_amqp_results_total')).toContain('result="duplicate"} 1');
  });

  it('409 (mismo eventId, otro contenido): a la DLQ con el motivo y ack, sin reintento', async () => {
    const { procesador, contador } = procesadorCon('repetido-distinto');
    const m = mensaje(sobre('booking.confirmed', randomUUID()));
    await procesador.procesar(canal, m);
    expect(canal.en(TOPOLOGIA.colaReintento)).toHaveLength(0);
    const [muerto] = canal.en(TOPOLOGIA.colaMuertos);
    expect(muerto.opciones.headers['x-estado']).toBe('CONFLICTO');
    expect(String(muerto.opciones.headers['x-motivo'])).toMatch(/^409 /);
    expect(muerto.contenido.equals(m.content)).toBe(true);
    expect(muerto.opciones.messageId).toBe(m.properties.messageId);
    expect(canal.acks).toEqual([m]);
    expect(await contador('notifier_amqp_results_total')).toContain('result="dead_lettered"} 1');
  });

  it('400 (sobre inválido): a la DLQ nombrando el campo, no el valor', async () => {
    const { procesador } = procesadorCon('nuevo');
    const invalido = { ...sobre('booking.confirmed', randomUUID()), eventId: 'no-es-un-uuid' };
    const m = mensaje(invalido);
    await procesador.procesar(canal, m);
    const [muerto] = canal.en(TOPOLOGIA.colaMuertos);
    expect(muerto.opciones.headers['x-estado']).toBe('SOBRE_INVALIDO');
    expect(String(muerto.opciones.headers['x-motivo'])).toMatch(/^400 /);
    expect(String(muerto.opciones.headers['x-motivo'])).not.toContain('no-es-un-uuid');
    expect(canal.acks).toEqual([m]);
    expect(canal.en(TOPOLOGIA.colaReintento)).toHaveLength(0);
  });

  it('422 (tipo desconocido): a la DLQ y ack', async () => {
    const { procesador } = procesadorCon('nuevo');
    const m = mensaje({ ...sobre('booking.confirmed', randomUUID()), eventType: 'otra.cosa' });
    await procesador.procesar(canal, m);
    const [muerto] = canal.en(TOPOLOGIA.colaMuertos);
    expect(String(muerto.opciones.headers['x-motivo'])).toMatch(/^422 /);
    expect(canal.acks).toEqual([m]);
  });

  it('un cuerpo que no es JSON: a la DLQ y ack', async () => {
    const { procesador } = procesadorCon('nuevo');
    const m = mensaje('{esto no es json');
    await procesador.procesar(canal, m);
    expect(canal.en(TOPOLOGIA.colaMuertos)[0].opciones.headers['x-estado']).toBe('JSON_INVALIDO');
    expect(canal.acks).toEqual([m]);
  });

  it('error transitorio: a la cola de reintento con x-intentos, ack, sin DLQ', async () => {
    const { procesador, contador } = procesadorCon('base-caida');
    const m = mensaje(sobre('booking.confirmed', randomUUID()));
    await procesador.procesar(canal, m);
    const [reintento] = canal.en(TOPOLOGIA.colaReintento);
    expect(reintento.opciones.headers['x-intentos']).toBe(1);
    expect(reintento.opciones.headers['x-routing-key-original']).toBe('booking.confirmed');
    expect(reintento.contenido.equals(m.content)).toBe(true);
    expect(canal.en(TOPOLOGIA.colaMuertos)).toHaveLength(0);
    expect(canal.acks).toEqual([m]);
    expect(await contador('notifier_amqp_results_total')).toContain('result="retried"} 1');
  });

  const muertes = (count: number) => [
    { queue: TOPOLOGIA.colaReintento, reason: 'expired', count, exchange: '', 'routing-keys': [] },
  ];

  it('tope de 5 intentos con x-death: al cuarto reintento aún reintenta; al quinto va a la DLQ', async () => {
    const { procesador } = procesadorCon('base-caida');
    const cuarto = mensaje(sobre('booking.confirmed', randomUUID()), { 'x-death': muertes(3) });
    await procesador.procesar(canal, cuarto);
    expect(canal.en(TOPOLOGIA.colaReintento)).toHaveLength(1);
    expect(canal.en(TOPOLOGIA.colaMuertos)).toHaveLength(0);

    const quinto = mensaje(sobre('booking.confirmed', randomUUID()), { 'x-death': muertes(4) });
    await procesador.procesar(canal, quinto);
    expect(canal.en(TOPOLOGIA.colaReintento)).toHaveLength(1);
    const [muerto] = canal.en(TOPOLOGIA.colaMuertos);
    expect(muerto.opciones.headers['x-estado']).toBe('REINTENTOS_AGOTADOS');
    expect(muerto.opciones.headers['x-intentos-previos']).toBe(5);
    // Quien reencole desde la DLQ empieza de cero
    expect(muerto.opciones.headers['x-death']).toBeUndefined();
    expect(muerto.opciones.headers['x-intentos']).toBeUndefined();
    expect(canal.acks).toContain(quinto);
  });

  it('cuenta también con x-intentos si el broker no conservó el x-death', async () => {
    const { procesador } = procesadorCon('base-caida');
    const m = mensaje(sobre('booking.confirmed', randomUUID()), { 'x-intentos': 4 });
    await procesador.procesar(canal, m);
    expect(canal.en(TOPOLOGIA.colaMuertos)).toHaveLength(1);
    expect(canal.en(TOPOLOGIA.colaReintento)).toHaveLength(0);
  });

  it('un x-death de otra cola no cuenta', async () => {
    const { procesador } = procesadorCon('base-caida');
    const otras = [{ queue: 'otra.cola', reason: 'expired', count: 9 }];
    await procesador.procesar(
      canal,
      mensaje(sobre('booking.confirmed', randomUUID()), { 'x-death': otras }),
    );
    expect(canal.en(TOPOLOGIA.colaReintento)).toHaveLength(1);
  });

  it('si no se puede publicar en la DLQ/reintento no hay ack: el broker reenvía', async () => {
    const { procesador } = procesadorCon('base-caida');
    canal.falloAlPublicar = true;
    const m = mensaje(sobre('booking.confirmed', randomUUID()));
    await expect(procesador.procesar(canal, m)).rejects.toThrow('canal cerrado');
    expect(canal.acks).toHaveLength(0);
  });

  it('el span de consumo continúa el traceparent del mensaje', async () => {
    const s = servicio('nuevo');
    const vistos: Array<string | null> = [];
    jest.spyOn(s.publicacion, 'publicar').mockImplementation(async () => {
      vistos.push(traceparentActivo());
      return { eventId: 'x', entregas: 0, duplicado: false };
    });
    const procesador = new ProcesadorMensajes(s.publicacion, s.observabilidad, new Reloj());
    const traceId = 'a'.repeat(32);
    const m = mensaje(sobre('booking.confirmed', randomUUID()), {
      traceparent: `00-${traceId}-${'b'.repeat(16)}-01`,
    });
    await procesador.procesar(canal, m);
    expect(vistos[0]).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    expect(vistos[0]).not.toContain('b'.repeat(16));
  });
});

describe('ConsumidorAmqp', () => {
  class FabricaFalsa extends FabricaAmqp {
    conexiones = 0;
    fallos = 0;
    readonly canal = new CanalFalso();
    cierre: ((e?: Error) => void) | undefined;
    async conectar(): Promise<ConexionAmqp> {
      this.conexiones++;
      if (this.fallos > 0) {
        this.fallos--;
        throw new Error('ECONNREFUSED amqp://usuario:clave@broker');
      }
      return {
        crearCanal: async () => this.canal,
        alCerrar: (escucha) => {
          this.cierre = escucha;
        },
        cerrar: async () => undefined,
      };
    }
  }

  function armar(valores: Record<string, unknown>) {
    const fabrica = new FabricaFalsa();
    const s = procesadorCon('nuevo');
    const consumidor = new ConsumidorAmqp(fabrica, s.procesador, s.observabilidad, config(valores));
    return { fabrica, consumidor, ...s };
  }

  it('con RABBITMQ_ENABLED=false no abre ninguna conexión', async () => {
    const { fabrica, consumidor } = armar({ RABBITMQ_ENABLED: 'false', RABBITMQ_URL: 'amqp://x' });
    consumidor.onApplicationBootstrap();
    await new Promise((r) => setTimeout(r, 20));
    expect(fabrica.conexiones).toBe(0);
    expect(consumidor.estado()).toBe('apagado');
    await consumidor.onModuleDestroy();
  });

  it('sin la variable (el valor por defecto) tampoco', () => {
    const { fabrica, consumidor } = armar({});
    consumidor.onApplicationBootstrap();
    expect(fabrica.conexiones).toBe(0);
    expect(consumidor.estado()).toBe('apagado');
  });

  it('al conectar declara la topología, aplica el prefetch y consume la principal', async () => {
    const { fabrica, consumidor, observabilidad } = armar({
      RABBITMQ_ENABLED: 'true',
      RABBITMQ_URL: 'amqp://x',
      RABBITMQ_PREFETCH: 7,
    });
    await consumidor.conectar();
    const c = fabrica.canal;
    expect(consumidor.estado()).toBe('conectado');
    expect(c.exchanges).toEqual([{ nombre: 'vuelos.eventos', tipo: 'topic' }]);
    expect([...c.colas.keys()].sort()).toEqual([
      'notifier.eventos',
      'notifier.eventos.dlq',
      'notifier.eventos.retry',
    ]);
    expect(c.colas.get('notifier.eventos.retry')).toEqual({
      'x-message-ttl': 30_000,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': 'notifier.eventos',
    });
    expect(c.ligas).toEqual([['notifier.eventos', 'vuelos.eventos', '#']]);
    expect(c.prefetchPedido).toBe(7);
    expect(c.alRecibir).toBeDefined();
    expect(
      await observabilidad.metricas.registro.getSingleMetricAsString('notifier_amqp_connected'),
    ).toContain('notifier_amqp_connected 1');
    await consumidor.onModuleDestroy();
  });

  it('el prefetch por defecto es 10', async () => {
    const { fabrica, consumidor } = armar({ RABBITMQ_ENABLED: 'true', RABBITMQ_URL: 'amqp://x' });
    await consumidor.conectar();
    expect(fabrica.canal.prefetchPedido).toBe(10);
    await consumidor.onModuleDestroy();
  });

  it('el arranque no espera al broker; si no está, reconecta con espera y luego consume', async () => {
    const { fabrica, consumidor } = armar({ RABBITMQ_ENABLED: 'true', RABBITMQ_URL: 'amqp://x' });
    fabrica.fallos = 1;
    const inicio = Date.now();
    consumidor.onApplicationBootstrap();
    expect(Date.now() - inicio).toBeLessThan(100);
    await new Promise((r) => setTimeout(r, 30));
    expect(fabrica.conexiones).toBe(1);
    expect(consumidor.estado()).toBe('desconectado');
    // La primera espera es de 1 a 1,25 s
    await new Promise((r) => setTimeout(r, REGLAS_AMQP.reconexionInicialMs * 1.25 + 200));
    expect(fabrica.conexiones).toBe(2);
    expect(consumidor.estado()).toBe('conectado');
    await consumidor.onModuleDestroy();
  }, 10_000);

  it('al perderse la conexión reconecta', async () => {
    const { fabrica, consumidor } = armar({ RABBITMQ_ENABLED: 'true', RABBITMQ_URL: 'amqp://x' });
    await consumidor.conectar();
    fabrica.cierre?.(new Error('se cayó'));
    expect(consumidor.estado()).toBe('desconectado');
    await new Promise((r) => setTimeout(r, REGLAS_AMQP.reconexionInicialMs * 1.25 + 200));
    expect(fabrica.conexiones).toBe(2);
    expect(consumidor.estado()).toBe('conectado');
    await consumidor.onModuleDestroy();
  }, 10_000);

  describe('intentos colgados o cortados a mitad', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    function armarCon(
      conectar: (
        n: number,
        canal: CanalFalso,
        f: { cierre?: (e?: Error) => void },
      ) => Promise<ConexionAmqp>,
    ) {
      const canal = new CanalFalso();
      const f: { cierre?: (e?: Error) => void } = {};
      let conexiones = 0;
      class Fabrica extends FabricaAmqp {
        async conectar(): Promise<ConexionAmqp> {
          return conectar(++conexiones, canal, f);
        }
      }
      const s = procesadorCon('nuevo');
      const consumidor = new ConsumidorAmqp(
        new Fabrica(),
        s.procesador,
        s.observabilidad,
        config({ RABBITMQ_ENABLED: 'true', RABBITMQ_URL: 'amqp://x' }),
      );
      return { consumidor, f, canal, conexiones: () => conexiones };
    }
    const normal = (canal: CanalFalso, f: { cierre?: (e?: Error) => void }): ConexionAmqp => ({
      crearCanal: async () => canal,
      alCerrar: (escucha) => {
        f.cierre = escucha;
      },
      cerrar: async () => undefined,
    });

    it('una conexión que nunca resuelve vence el plazo y se reintenta', async () => {
      const { consumidor, conexiones } = armarCon((n, canal, f) =>
        n === 1 ? new Promise<ConexionAmqp>(() => undefined) : Promise.resolve(normal(canal, f)),
      );
      consumidor.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(REGLAS_AMQP.plazoIntentoMs - 100);
      expect(consumidor.estado()).toBe('conectando');
      await jest.advanceTimersByTimeAsync(200);
      expect(consumidor.estado()).toBe('desconectado');
      await jest.advanceTimersByTimeAsync(REGLAS_AMQP.reconexionInicialMs * 1.25 + 50);
      expect(conexiones()).toBe(2);
      expect(consumidor.estado()).toBe('conectado');
      await consumidor.onModuleDestroy();
    });

    it('un cierre durante la declaración agenda un único reintento', async () => {
      let soltar: (() => void) | undefined;
      const { consumidor, f, canal, conexiones } = armarCon(async (n, c, ff) => {
        if (n > 1) return normal(c, ff);
        const base = normal(c, ff);
        return {
          ...base,
          crearCanal: async () =>
            ({
              ...c,
              declararExchange: () =>
                new Promise<void>((_, rechazar) => (soltar = () => rechazar(new Error('cerrado')))),
            }) as unknown as CanalFalso,
        };
      });
      consumidor.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(10);
      f.cierre?.(new Error('se cayó')); // el evento de cierre agenda el reintento...
      soltar?.(); // ...y la declaración fallida intentaría agendar otro
      await jest.advanceTimersByTimeAsync(REGLAS_AMQP.reconexionMaximaMs * 2);
      expect(conexiones()).toBe(2);
      expect(consumidor.estado()).toBe('conectado');
      expect(canal.exchanges).toHaveLength(1);
      await consumidor.onModuleDestroy();
    });
  });

  it('un mensaje que llega por el consumo se procesa y se confirma', async () => {
    const { fabrica, consumidor } = armar({ RABBITMQ_ENABLED: 'true', RABBITMQ_URL: 'amqp://x' });
    await consumidor.conectar();
    const m = mensaje(sobre('booking.confirmed', randomUUID()));
    fabrica.canal.alRecibir?.(m);
    await consumidor.onModuleDestroy(); // espera lo que esté en curso
    expect(fabrica.canal.acks).toEqual([m]);
  });
});

describe('entorno de RabbitMQ', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    PORT: '3002',
    NODE_ENV: 'test',
    WEBHOOK_SECRET_KEY: 'x'.repeat(40),
    JWT_ISSUER: 'https://identity.e2e.quinde.example',
    JWT_AUDIENCE: 'quinde-vuelos-api',
  };

  it('por defecto no hace falta nada', () => {
    const v = validarEntorno(base);
    expect(v.RABBITMQ_ENABLED).toBeUndefined();
  });

  it('habilitado exige RABBITMQ_URL, y no repite el valor en el error', () => {
    expect(() => validarEntorno({ ...base, RABBITMQ_ENABLED: 'true' })).toThrow(/RABBITMQ_URL/);
    expect(() =>
      validarEntorno({ ...base, RABBITMQ_ENABLED: 'true', RABBITMQ_URL: 'http://u:clave@h' }),
    ).toThrow(/RABBITMQ_URL/);
    try {
      validarEntorno({
        ...base,
        RABBITMQ_ENABLED: 'true',
        RABBITMQ_URL: 'http://u:clave-secreta@h',
      });
    } catch (e) {
      expect((e as Error).message).not.toContain('clave-secreta');
    }
    expect(
      validarEntorno({ ...base, RABBITMQ_ENABLED: 'true', RABBITMQ_URL: 'amqp://u:p@rabbit:5672' })
        .RABBITMQ_ENABLED,
    ).toBe('true');
  });

  it('valida RABBITMQ_ENABLED y RABBITMQ_PREFETCH', () => {
    expect(() => validarEntorno({ ...base, RABBITMQ_ENABLED: 'si' })).toThrow(/RABBITMQ_ENABLED/);
    expect(() => validarEntorno({ ...base, RABBITMQ_PREFETCH: '0' })).toThrow(/RABBITMQ_PREFETCH/);
    expect(() => validarEntorno({ ...base, RABBITMQ_PREFETCH: '5000' })).toThrow(
      /RABBITMQ_PREFETCH/,
    );
    expect(validarEntorno({ ...base, RABBITMQ_PREFETCH: '25' }).RABBITMQ_PREFETCH).toBe(25);
  });
});

describe('latido de la conexión', () => {
  it('añade heartbeat=15 sin tocar credenciales, y respeta uno ya puesto', () => {
    expect(conLatido('amqp://u:p%40x@h:5672/')).toBe('amqp://u:p%40x@h:5672/?heartbeat=15');
    expect(conLatido('amqp://u:p@h:5672/?heartbeat=5')).toBe('amqp://u:p@h:5672/?heartbeat=5');
  });
});
