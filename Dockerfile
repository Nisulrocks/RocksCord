# Container image for RocksCord.
#
# Not needed for Render (which builds from source) or for local development.
# This exists for hosts that want an image — Fly.io, Koyeb, Railway, a VPS, or
# Docker Desktop.
#
#   docker build -t rockscord .
#   docker run -p 4000:4000 -v rockscord-data:/app/data rockscord
#
# The volume matters: without it the SQLite database and uploads live inside
# the container and vanish when it is replaced.

FROM node:24-slim AS build
WORKDIR /app

# Install with the lockfile first so this layer caches across source changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY . .
RUN npm run build -w @rockscord/shared \
 && npm run build -w @rockscord/server \
 && npm run build -w @rockscord/web

# --- runtime ---------------------------------------------------------------

FROM node:24-slim
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    SERVE_CLIENT=true

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /app/apps/web/dist ./apps/web/dist

# The database and uploads live here. Mount a volume over it to persist them.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

VOLUME ["/app/data"]
EXPOSE 4000

# The server applies migrations itself on boot, so there is no separate step.
CMD ["node", "apps/server/dist/index.js"]
