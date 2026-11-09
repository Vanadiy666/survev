# uWebSockets.js ARM64 binaries require glibc >= 2.38.
FROM node:22-trixie AS dependencies
WORKDIR /app
# Native client build dependencies; git is also needed for uWebSockets.js.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git gosu python3 make g++ pkg-config libcairo2-dev libpango1.0-dev \
    libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g "$(node -p 'require("./package.json").packageManager')"
COPY server/package.json server/package.json
COPY client/package.json client/package.json
COPY shared/package.json shared/package.json
COPY bot/package.json bot/package.json
COPY tests/package.json tests/package.json
RUN pnpm install --frozen-lockfile
COPY . .

FROM dependencies AS server-build
RUN pnpm --filter @survev/server build

# Keep the source and migration tooling so the same image can run db:migrate.
FROM server-build AS server
ENV NODE_ENV=production
WORKDIR /app/server
RUN mkdir -p /config /app/server/lost_game_data \
    && chown -R node:node /config /app
USER node
ENTRYPOINT ["sh", "/app/docker/entrypoint.sh"]

FROM dependencies AS client-build
ARG PUBLIC_HOST=localhost
ARG WEB_PORT=8080
ARG GAME_PORT=8001
# Optional affinity limit for atlas workers on small build machines.
ARG CLIENT_BUILD_CPUSET=""
RUN node docker/config.mjs build \
    && if [ -n "$CLIENT_BUILD_CPUSET" ]; then \
        taskset -c "$CLIENT_BUILD_CPUSET" pnpm --filter @survev/client build; \
    else \
        pnpm --filter @survev/client build; \
    fi

FROM nginx:stable-bookworm AS web
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
ENV NGINX_ENVSUBST_FILTER=^NGINX_LOCAL_RESOLVERS$
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=client-build /app/client/dist /usr/share/nginx/html
