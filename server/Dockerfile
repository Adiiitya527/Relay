# syntax=docker/dockerfile:1
# Relay server image: one image, three commands (migrate, API, worker).
# Build from the repository root:  docker build -f server/Dockerfile .

# --- build: install all deps (incl. TypeScript), compile src/ to dist/ ---------------------
FROM node:24-alpine AS build
WORKDIR /app
# Workspace manifests first, so `npm ci` is cached until a dependency changes.
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json server/
COPY dashboard/package.json dashboard/
COPY mock-consumer/package.json mock-consumer/
RUN npm ci --workspace server --include-workspace-root
COPY server/ server/
RUN npm run build -w server

# --- runtime: production deps only, compiled JS, migrations, non-root ----------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY dashboard/package.json dashboard/
COPY mock-consumer/package.json mock-consumer/
RUN npm ci --omit=dev --workspace server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY server/migrations server/migrations
WORKDIR /app/server
USER node
EXPOSE 3000
# Config comes only from environment variables (invariant 10); there is no .env in the image.
CMD ["node", "--enable-source-maps", "dist/server.js"]
