import { CodigoError } from '../../src/common/errores/codigo-error';

const CAMPOS = ['type', 'title', 'status', 'detail', 'code', 'invalidParams'];

/**
 * Comprueba que el cuerpo es un ProblemDetails con la misma forma que el del core: campos
 * obligatorios, ningún campo extra y `code` dentro de la lista.
 */
export function esperarProblemDetails(respuesta: {
  status: number;
  type: string;
  body: Record<string, unknown>;
}): void {
  expect(respuesta.type).toBe('application/problem+json');
  expect(Object.keys(respuesta.body).filter((c) => !CAMPOS.includes(c))).toEqual([]);
  expect(typeof respuesta.body.type).toBe('string');
  expect(typeof respuesta.body.title).toBe('string');
  expect(respuesta.body.status).toBe(respuesta.status);
  expect(Object.values(CodigoError)).toContain(respuesta.body.code);
}
