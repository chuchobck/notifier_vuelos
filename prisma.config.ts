// Configuración del CLI de Prisma 7. Prisma ya no lee .env por su cuenta.
// La base nace de db/*.sql: aquí solo se usan "prisma db pull" y "prisma generate", nunca migrate.
//
// prisma/schema.prisma lo reescribe db pull (borra los comentarios). Su generator fija
// importFileExtension = "" y moduleFormat = "cjs": si no, Prisma deduce la extensión del
// tsconfig y dentro de docker build, donde todavía no hay tsconfig, genera imports a .ts que
// Node no carga.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // process.env y no env(): "prisma generate" corre sin base (por ejemplo, en docker build).
    url: process.env.DATABASE_URL,
  },
});
