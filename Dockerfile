# syntax=docker/dockerfile:1
# Imagen de Quinde · Notifier. No lleva credenciales ni claves: todo llega por variables de
# entorno (ver docs/DEPLOY.md). Corre como el usuario node, sin privilegios.
#
#   docker build -t quinde-notifier .
#   docker run --rm -p 3002:3002 --env-file .env.produccion quinde-notifier

ARG NODE_VERSION=22

# --- 1. compilación: dependencias completas, cliente de Prisma y dist/ ---------
FROM node:${NODE_VERSION}-bookworm-slim AS compilacion
WORKDIR /app

# El postinstall corre "prisma generate", que necesita el esquema y su configuración.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# --- 2. ejecución: solo dependencias de producción, lo compilado y los esquemas --
FROM node:${NODE_VERSION}-bookworm-slim AS ejecucion
ENV NODE_ENV=production
WORKDIR /app

# --ignore-scripts: el cliente de Prisma ya viene compilado en dist/generated, y husky y el CLI
# de prisma son dependencias de desarrollo. --omit=optional: @prisma/client declara prisma y
# typescript como peers opcionales; sin esto entran ~250 MB del CLI (lo mismo que en el core).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force

COPY --from=compilacion /app/dist ./dist
# Los esquemas versionados de los eventos: el servicio los compila al arrancar (y no levanta sin
# ellos). Se leen desde dist/modules/evento/contrato, cuatro niveles arriba: /app/contracts/events
COPY contracts/events ./contracts/events

# Sin privilegios: el usuario node de la imagen oficial (uid 1000). Nada en /app es suyo, así
# que el proceso no puede reescribir su propio código ni sus contratos.
USER node
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3002) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
