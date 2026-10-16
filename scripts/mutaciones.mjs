#!/usr/bin/env node
// "Rompe a propósito lo que cada prueba cubre": aplica una mutación al código (aceptar alg none,
// dejar publicar a una persona, repartir a suscripciones ajenas, quitar SKIP LOCKED, loguear el
// secreto...), corre la prueba que la debería detectar y exige que FALLE. Restaura el archivo
// siempre, también si se corta con Ctrl+C. Una prueba que no falla al romper lo que cubre no
// prueba nada.
//
//   npm run test:mutaciones                    (todas; necesita PostgreSQL, como las pruebas)
//   npm run test:mutaciones -- skip-locked     (solo las que contienen ese texto en el nombre)
//
// Una mutación cuyo texto ya no está en el código (alguien cambió esa línea) cuenta como fallo
// del script: hay que actualizarla aquí. No corre en CI: tarda unos minutos.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const VERIFICADOR = 'src/modules/auth/seguridad/verificador-jwks.ts';
const CLAVES = 'src/modules/auth/seguridad/claves-jwks.ts';
const GUARD_JWT = 'src/common/guards/jwt-auth.guard.ts';
const GUARD_SCOPES = 'src/common/guards/scopes.guard.ts';
const EVENTO_CONTROLLER = 'src/modules/evento/evento.controller.ts';
const EVENTO_REPO = 'src/modules/evento/evento.repository.ts';
const EVENTO_SERVICE = 'src/modules/evento/evento.service.ts';
const ENTREGA_REPO = 'src/modules/entrega/entrega.repository.ts';
const ENTREGA = 'src/modules/entrega/entrega-webhooks.ts';
const CLIENTE_HTTP = 'src/modules/entrega/cliente-webhook-http.ts';
const FIRMA = 'src/modules/compartido/firma-webhook.ts';
const CIFRADO = 'src/modules/compartido/cifrado-secreto.ts';
const EVENTOS_WEBHOOK = 'src/modules/compartido/eventos-webhook.ts';
const SUSCRIPCION_SERVICE = 'src/modules/suscripcion/suscripcion.service.ts';
const SUSCRIPCION_REPO = 'src/modules/suscripcion/suscripcion.repository.ts';
const AUDITORIA = 'src/modules/auditoria/auditoria.service.ts';

const TOKEN = 'test/token.e2e-spec.ts';
const PUBLICACION = 'test/publicacion.e2e-spec.ts';
const ENTREGA_PRUEBA = 'test/entrega.e2e-spec.ts';
const SUSCRIPCIONES = 'test/suscripciones.e2e-spec.ts';
const ESCANEO = 'test/escaneo.e2e-spec.ts';
const UNIDADES = 'test/unidades.e2e-spec.ts';
const IMPORTACION = 'test/importacion.e2e-spec.ts';

/** nombre, archivo, cambios [buscar, reemplazar], prueba y filtro (-t) que debe fallar. */
const MUTACIONES = [
  // --- lo que pide la fase -------------------------------------------------------------------
  {
    nombre: 'persona-publica: un token de persona (sin client_id) publica eventos',
    archivo: GUARD_SCOPES,
    cambios: [['if (soloClientes && usuario?.clienteId === undefined) {', 'if (false) {']],
    prueba: TOKEN,
    filtro: 'una persona con events:publish tampoco publica',
  },
  {
    nombre: 'scope-publicar: basta flights:webhooks para publicar',
    archivo: EVENTO_CONTROLLER,
    cambios: [["  @Scopes('events:publish')\n", "  @Scopes('flights:webhooks')\n"]],
    prueba: TOKEN,
    filtro: 'una persona con flights:webhooks pero sin events:publish',
  },
  {
    nombre: 'reparto-ajeno: el evento se reparte también a suscripciones de otros dueños',
    archivo: EVENTO_REPO,
    cambios: [
      [
        '       WHERE s.id_propietario = ${reparto.idPropietario} AND s.activo',
        '       WHERE s.activo',
      ],
    ],
    prueba: PUBLICACION,
    filtro: 'solo a las suscripciones del dueño',
  },
  {
    nombre: 'skip-locked: reclamar sin SKIP LOCKED (un proceso espera al otro)',
    archivo: ENTREGA_REPO,
    cambios: [['           FOR UPDATE OF e SKIP LOCKED', '           FOR UPDATE OF e']],
    prueba: ENTREGA_PRUEBA,
    filtro: 'SKIP LOCKED',
  },
  {
    nombre: 'firma-entrega: la firma no incluye el timestamp (el tercero no la puede verificar)',
    archivo: FIRMA,
    cambios: [['.update(`${timestamp}.${cuerpo}`)', '.update(cuerpo)']],
    prueba: ENTREGA_PRUEBA,
    filtro: 'firma verificable por código independiente',
  },
  {
    nombre: 'firma-token: no se comprueba la firma del token (se decodifica sin verificar)',
    archivo: VERIFICADOR,
    cambios: [
      [
        '      ({ payload } = await jwtVerify(token, (cabecera) => this.claveDe(cabecera), {',
        "      payload = require('jose').decodeJwt(token);\n      if (Math.random() > 2) await jwtVerify(token, (cabecera) => this.claveDe(cabecera), {",
      ],
      [
        '        currentDate: this.reloj.ahora(),\n      }));',
        '        currentDate: this.reloj.ahora(),\n      });',
      ],
    ],
    prueba: TOKEN,
    filtro: 'el kid de la clave real con la firma de otra',
  },
  {
    nombre: 'loguear-secreto: la entrega escribe el secreto en el log',
    archivo: ENTREGA,
    cambios: [
      [
        '    const cuerpo = JSON.stringify(e.cuerpo);',
        '    this.logger.log(`Firmando con ${secreto}`);\n    const cuerpo = JSON.stringify(e.cuerpo);',
      ],
    ],
    prueba: ESCANEO,
    filtro: 'los logs no tienen secretos',
  },
  {
    nombre: 'alg-none: el verificador acepta un token sin firma',
    archivo: VERIFICADOR,
    cambios: [
      [
        '    let payload: Record<string, unknown>;\n    try {',
        "    let payload: Record<string, unknown>;\n    const jose = require('jose');\n    if (jose.decodeProtectedHeader(token).alg === 'none') {\n      const c = jose.decodeJwt(token);\n      return { sub: String(c.sub), scopes: String(c.scope).split(' '), jti: 'x', clienteId: c.client_id };\n    }\n    try {",
      ],
    ],
    prueba: TOKEN,
    filtro: 'alg none',
  },
  {
    nombre: 'jwks-caido: con el JWKS caído y sin copia se deja pasar',
    archivo: GUARD_JWT,
    cambios: [
      [
        '      if (error instanceof JwksNoDisponibleError) throw servicioNoDisponible(error);',
        "      if (error instanceof JwksNoDisponibleError) {\n        peticion.usuario = { id: '00000000-0000-4000-8000-000000000000', scopes: ['events:publish', 'flights:webhooks'], idToken: 'x', clienteId: 'x' };\n        return true;\n      }",
      ],
    ],
    prueba: TOKEN,
    filtro: 'JWKS caído SIN copia',
  },
  // --- el resto del verificador (la fase 4b del core) ------------------------------------------
  {
    nombre: 'hs256: el verificador acepta HS256 con la clave pública como secreto',
    archivo: VERIFICADOR,
    cambios: [
      ['algorithms: [ALGORITMO_EXTERNO],', "algorithms: [ALGORITMO_EXTERNO, 'HS256'],"],
      [
        '    if (clave === undefined) throw new errors.JWKSNoMatchingKey();\n    return clave;',
        "    if (clave === undefined) throw new errors.JWKSNoMatchingKey();\n    if (cabecera.alg === 'HS256') return new TextEncoder().encode(require('node:crypto').KeyObject.from(clave).export({ type: 'spki', format: 'pem' })) as unknown as CryptoKey;\n    return clave;",
      ],
    ],
    prueba: TOKEN,
    filtro: 'HS256 firmado con la clave pública',
  },
  {
    nombre: 'aud: no se comprueba la audiencia',
    archivo: VERIFICADOR,
    cambios: [['        audience: this.config.audiencia,\n', '']],
    prueba: TOKEN,
    filtro: 'aud ajeno',
  },
  {
    nombre: 'iss: no se comprueba el emisor',
    archivo: VERIFICADOR,
    cambios: [['        issuer: this.config.emisor,\n', '']],
    prueba: TOKEN,
    filtro: 'iss ajeno',
  },
  {
    nombre: 'typ: no se exige at+jwt',
    archivo: VERIFICADOR,
    cambios: [['        typ: TIPO_TOKEN_ACCESO,\n', '']],
    prueba: TOKEN,
    filtro: 'typ distinto',
  },
  {
    nombre: 'exp-obligatorio: un token sin exp pasa',
    archivo: VERIFICADOR,
    cambios: [
      ["requiredClaims: ['exp', 'iat', 'jti', 'sub'],", "requiredClaims: ['iat', 'jti', 'sub'],"],
    ],
    prueba: TOKEN,
    filtro: 'sin exp',
  },
  {
    nombre: 'enfriamiento: cada kid inventado baja el JWKS otra vez',
    archivo: CLAVES,
    cambios: [['export const ENFRIAMIENTO_MS = 10_000;', 'export const ENFRIAMIENTO_MS = 0;']],
    prueba: TOKEN,
    filtro: '100 kid inventados',
  },
  // --- publicación ---------------------------------------------------------------------------
  {
    nombre: 'reparto-inactivas: una suscripción dada de baja recibe el evento',
    archivo: EVENTO_REPO,
    cambios: [
      [
        '       WHERE s.id_propietario = ${reparto.idPropietario} AND s.activo',
        '       WHERE s.id_propietario = ${reparto.idPropietario}',
      ],
    ],
    prueba: PUBLICACION,
    filtro: 'ninguna inactiva',
  },
  {
    nombre: 'reparto-tipo: el evento llega a suscripciones que no escuchan ese tipo',
    archivo: EVENTO_REPO,
    cambios: [
      [
        'ON se.suscripcion_id = s.id AND se.tipo_evento = ${reparto.tipo}',
        'ON se.suscripcion_id = s.id',
      ],
    ],
    prueba: PUBLICACION,
    filtro: 'solo a las que escuchan ese tipo',
  },
  {
    nombre: 'idempotencia: una repetición del eventId no se reconoce',
    archivo: EVENTO_REPO,
    cambios: [['      ON CONFLICT ON CONSTRAINT uq_evento_id_evento DO NOTHING\n', '']],
    prueba: PUBLICACION,
    filtro: 'la repetición responde 200',
  },
  {
    nombre: 'huella: el mismo eventId con otro contenido pasa como repetición',
    archivo: EVENTO_SERVICE,
    cambios: [['if (existente.huella !== huella) {', 'if (false) {']],
    prueba: PUBLICACION,
    filtro: 'con otro contenido es 409',
  },
  // --- entrega -------------------------------------------------------------------------------
  {
    // Sin candado, dos reclamos que se cruzan envían la misma entrega; si no se cruzan (depende de
    // la máquina), igual se nota: el UPDATE espera la fila que otro proceso tiene tomada
    nombre: 'sin-for-update: reclamar sin bloquear las filas',
    archivo: ENTREGA_REPO,
    cambios: [['           FOR UPDATE OF e SKIP LOCKED\n', '']],
    prueba: ENTREGA_PRUEBA,
    filtro: 'SKIP LOCKED',
  },
  {
    nombre: 'ssrf-al-enviar: no se vuelve a comprobar la dirección al conectar',
    archivo: CLIENTE_HTTP,
    cambios: [
      [
        'if (lista.some((d) => direccionProhibida(',
        'if (false && lista.some((d) => direccionProhibida(',
      ],
    ],
    prueba: ENTREGA_PRUEBA,
    filtro: 'resuelve a una red privada',
  },
  {
    nombre: 'arrendamiento: tomar una entrega no la aparta de los demás procesos',
    archivo: ENTREGA_REPO,
    cambios: [
      [
        '               proximo_intento = ${ahora}::timestamptz + make_interval(secs => ${arrendamientoSegundos}),',
        '               proximo_intento = e.proximo_intento + make_interval(secs => ${arrendamientoSegundos} * 0),',
      ],
    ],
    prueba: ENTREGA_PRUEBA,
    filtro: 'muere a mitad de un envío',
  },
  {
    nombre: 'intento-condicionado: un resultado atrasado pisa al nuevo',
    archivo: ENTREGA_REPO,
    cambios: [
      [
        "       WHERE id = ${id} AND estado = 'PENDIENTE' AND intentos = ${intentos}",
        "       WHERE id = ${id} AND estado = 'PENDIENTE'",
      ],
    ],
    prueba: ENTREGA_PRUEBA,
    filtro: 'resultados atrasados',
  },
  {
    nombre: 'esperas: la cuarta espera es de 1 h en vez de 2 h',
    archivo: ENTREGA,
    cambios: [['  esperasMinutos: [1, 5, 30, 120],', '  esperasMinutos: [1, 5, 30, 60],']],
    prueba: ENTREGA_PRUEBA,
    filtro: '1 min, 5 min, 30 min, 2 h',
  },
  {
    nombre: 'baja-automatica: se da de baja tras 9 fallidas',
    archivo: ENTREGA,
    cambios: [['  fallidasSeguidasParaBaja: 10,', '  fallidasSeguidasParaBaja: 9,']],
    prueba: ENTREGA_PRUEBA,
    filtro: '10 entregas FALLIDO seguidas',
  },
  {
    nombre: 'loguear-url: la línea de cada intento lleva la URL',
    archivo: ENTREGA,
    cambios: [
      [
        '      `Entrega ${e.id} (${e.tipo}) intento',
        '      `Entrega ${e.id} ${e.url} (${e.tipo}) intento',
      ],
    ],
    prueba: ENTREGA_PRUEBA,
    filtro: 'cada intento deja una línea sin URL',
  },
  // --- suscripciones y migración -------------------------------------------------------------
  {
    nombre: 'ssrf-al-registrar: se acepta una URL hacia una red interna',
    archivo: SUSCRIPCION_SERVICE,
    cambios: [['    if (motivo !== null) {', '    if (false) {']],
    prueba: SUSCRIPCIONES,
    filtro: 'metadata de la nube',
  },
  {
    nombre: 'candado-maximo: dos altas simultáneas pasan del máximo de 10',
    archivo: SUSCRIPCION_REPO,
    cambios: [
      [
        "    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'suscripcion:' + idPropietario}, 0))`;\n",
        '',
      ],
    ],
    prueba: SUSCRIPCIONES,
    filtro: 'altas simultáneas no pasan de 10',
  },
  {
    nombre: 'baja-ajena: se puede dar de baja la suscripción de otro usuario',
    archivo: SUSCRIPCION_REPO,
    cambios: [
      [
        '    const { count } = await tx.suscripcion.updateMany({\n      where: { id, id_propietario: idPropietario, activo: true },',
        '    const { count } = await tx.suscripcion.updateMany({\n      where: { id, activo: true },',
      ],
      [
        '    const actual = await tx.suscripcion.findFirst({\n      where: { id, id_propietario: idPropietario, activo: true },',
        '    const actual = await tx.suscripcion.findFirst({\n      where: { id, activo: true },',
      ],
    ],
    prueba: SUSCRIPCIONES,
    filtro: '404 si es de otro usuario',
  },
  {
    nombre: 'secreto-en-respuesta: la API devuelve el secreto sin enmascarar',
    archivo: EVENTOS_WEBHOOK,
    cambios: [['  return `****${secreto.slice(-4)}`;', '  return secreto;']],
    prueba: SUSCRIPCIONES,
    filtro: 'secreto enmascarado',
  },
  {
    nombre: 'auditoria-url: la auditoría guarda la URL completa',
    archivo: AUDITORIA,
    cambios: [['      host_destino: hostDe(registro.url),', '      host_destino: registro.url,']],
    prueba: ESCANEO,
    filtro: 'la auditoría no tiene secretos',
  },
  {
    nombre: 'cifrado-del-core: otra sal de HKDF (los secretos del core no se migran)',
    archivo: CIFRADO,
    cambios: [["        'quinde-vuelos',", "        'quinde-notifier',"]],
    prueba: UNIDADES,
    filtro: 'formato del core',
  },
  {
    nombre: 'migracion-firma: una suscripción importada no firma con el secreto original',
    archivo: CIFRADO,
    cambios: [["        'webhook-secreto',", "        'webhook-secreto-v2',"]],
    prueba: IMPORTACION,
    filtro: 'secreto ORIGINAL del core',
  },
];

const filtroNombre = process.argv[2];
const elegidas = MUTACIONES.filter((m) => !filtroNombre || m.nombre.includes(filtroNombre));
const resultados = [];
const originales = new Map();

// Ctrl+C a mitad de una mutación: se restaura el archivo antes de salir
process.on('SIGINT', () => {
  for (const [archivo, contenido] of originales) writeFileSync(archivo, contenido);
  process.exit(130);
});

for (const mutacion of elegidas) {
  const original = readFileSync(mutacion.archivo, 'utf8');
  let mutado = original;
  const faltan = mutacion.cambios.filter(([buscar]) => original.split(buscar).length !== 2);
  if (faltan.length > 0) {
    resultados.push({ ...mutacion, estado: 'NO APLICABLE (el texto ya no está una sola vez)' });
    continue;
  }
  for (const [buscar, reemplazar] of mutacion.cambios) {
    mutado = mutado.replace(buscar, () => reemplazar);
  }
  originales.set(mutacion.archivo, original);
  try {
    writeFileSync(mutacion.archivo, mutado);
    const corrida = spawnSync(
      'npx',
      [
        'jest',
        '--config',
        'test/jest-e2e.json',
        '--runInBand',
        mutacion.prueba,
        '-t',
        mutacion.filtro,
      ],
      { encoding: 'utf8' },
    );
    const salida = `${corrida.stdout}${corrida.stderr}`;
    const fallidas = salida.match(/Tests:\s+(\d+) failed/)?.[1] ?? '0';
    resultados.push({
      ...mutacion,
      estado:
        corrida.status !== 0 && fallidas !== '0'
          ? `DETECTADA (${fallidas} prueba(s) fallan)`
          : 'SOBREVIVIÓ',
    });
  } finally {
    writeFileSync(mutacion.archivo, original);
    originales.delete(mutacion.archivo);
  }
}

for (const r of resultados) {
  console.log(
    `${r.estado.startsWith('DETECTADA') ? 'ok ' : 'MAL'}  ${r.nombre}\n     ${r.prueba} -t "${r.filtro}" → ${r.estado}`,
  );
}
const malas = resultados.filter((r) => !r.estado.startsWith('DETECTADA'));
console.log(`\n${resultados.length - malas.length} de ${resultados.length} mutaciones detectadas`);
process.exit(malas.length === 0 ? 0 : 1);
