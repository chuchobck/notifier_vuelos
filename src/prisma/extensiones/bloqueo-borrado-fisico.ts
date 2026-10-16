import { Prisma } from '../../generated/prisma/client';

/**
 * Tablas que sí se pueden borrar físicamente. Ninguna: una suscripción se da de baja con
 * `activo = false`, un evento y sus entregas son el registro de lo que se envió (la bandeja de
 * salida no se borra) y la auditoría es de solo inserción. Cuando exista una tarea que purgue
 * eventos viejos ya entregados, se agrega aquí con su justificación.
 */
export const TABLAS_CON_BORRADO_FISICO: ReadonlySet<Prisma.ModelName> = new Set<Prisma.ModelName>(
  [],
);

export class BorradoFisicoProhibidoError extends Error {
  constructor(
    readonly modelo: string,
    readonly operacion: 'delete' | 'deleteMany',
  ) {
    super(
      `${operacion} sobre "${modelo}" está prohibido: usa la eliminación lógica (activo = false)`,
    );
    this.name = 'BorradoFisicoProhibidoError';
  }
}

function exigirBorradoPermitido(modelo: string, operacion: 'delete' | 'deleteMany'): void {
  if (!TABLAS_CON_BORRADO_FISICO.has(modelo as Prisma.ModelName)) {
    throw new BorradoFisicoProhibidoError(modelo, operacion);
  }
}

/**
 * Corta `delete` y `deleteMany` antes de que lleguen a la base (como en el core y en identity).
 * No cubre los borrados anidados dentro de un `update` ni `$executeRaw`: en esos casos el freno
 * es la revisión de código y los `ON DELETE RESTRICT` del esquema.
 */
export const bloqueoBorradoFisico = Prisma.defineExtension({
  name: 'bloqueo-borrado-fisico',
  query: {
    $allModels: {
      delete({ model, args, query }) {
        exigirBorradoPermitido(model, 'delete');
        return query(args);
      },
      deleteMany({ model, args, query }) {
        exigirBorradoPermitido(model, 'deleteMany');
        return query(args);
      },
    },
  },
});
