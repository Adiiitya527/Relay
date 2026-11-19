# syntax=docker/dockerfile:1
# Dashboard: built with Vite, served by nginx, which also forwards /v1 and /healthz to the
# API, so the browser sees ONE origin (no CORS) exactly like the Vite dev proxy.
# Build from the repository root:  docker build -f dashboard/Dockerfile .

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json server/
COPY dashboard/package.json dashboard/
COPY mock-consumer/package.json mock-consumer/
RUN npm ci --workspace dashboard --include-workspace-root
COPY dashboard/ dashboard/
RUN npm run build -w dashboard

FROM nginx:1.27-alpine
# The official image renders /etc/nginx/templates/*.template with envsubst at start-up, so
# the API address is configuration, not a hard-coded host (invariant 10).
ENV RELAY_API_UPSTREAM=http://api:3000
COPY dashboard/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dashboard/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=5s --timeout=3s --retries=10 CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
