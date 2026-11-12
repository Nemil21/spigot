# One image for the Spigot API and the Bluebonnet demo site (docker-compose.yml picks the command).
# Dev dependencies stay in: the demo CLIs (seed:demo, demo:reset, sim:buyers, …) run through tsx,
# e.g. `docker compose exec api npm run seed:demo`.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# Workspace manifests first, so `npm ci` is cached until a dependency changes.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/demo-site/package.json apps/demo-site/
COPY apps/web/package.json apps/web/
COPY apps/workflows/package.json apps/workflows/
COPY packages/gate/package.json packages/gate/
COPY packages/shared/package.json packages/shared/
COPY db/package.json db/
RUN npm ci --include=dev

COPY . .

# Baked into the web build (public values, not secrets): pass them as build args.
ARG VITE_AG_GRID_LICENSE_KEY=""
ARG VITE_PAYPAL_CLIENT_ID=""
RUN VITE_AG_GRID_LICENSE_KEY="$VITE_AG_GRID_LICENSE_KEY" VITE_PAYPAL_CLIENT_ID="$VITE_PAYPAL_CLIENT_ID" \
    npm run build

ENV NODE_ENV=production HOST=0.0.0.0
EXPOSE 3000 4100
CMD ["sh", "-c", "npm run migrate && exec node apps/api/dist/main.js"]
