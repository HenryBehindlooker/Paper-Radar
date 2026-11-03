# syntax=docker/dockerfile:1.7
# Paper-Radar – Multi-Stage-Build. Ein Image für App und Worker:
#   App:    node build            (Standard-CMD)
#   Worker: node dist/worker.js
#   Migration: node dist/migrate.js

ARG NODE_IMAGE=node:lts-alpine

# --- Abhängigkeiten (inkl. Dev) für den Build ---------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# Optional: CA-Zertifikat für Build-Umgebungen hinter TLS-Proxys
#   docker build --secret id=npm_ca,src=/pfad/ca.pem .
RUN --mount=type=secret,id=npm_ca,required=false \
	--mount=type=cache,target=/root/.npm \
	if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm_config_cafile=/run/secrets/npm_ca; fi; \
	npm ci --no-audit --no-fund

# --- Build: SvelteKit-App (adapter-node) und gebündelter Worker ----------------
FROM deps AS build
COPY . .
RUN npx svelte-kit sync && npm run build

# --- Nur Laufzeit-Abhängigkeiten ----------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=npm_ca,required=false \
	--mount=type=cache,target=/root/.npm \
	if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm_config_cafile=/run/secrets/npm_ca; fi; \
	npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# --- Laufzeit-Image -----------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="Paper-Radar" \
	org.opencontainers.image.source="https://github.com/HenryBehindlooker/Paper-Radar" \
	org.opencontainers.image.licenses="AGPL-3.0-only"
ENV NODE_ENV=production \
	PORT=3000 \
	MIGRATIONS_FOLDER=/app/migrations
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/lib/server/db/migrations ./migrations
COPY --chown=node:node package.json LICENSE ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build"]
