# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:1681862882da07ee5476fee047bcf34138833f1df42633bb25bcb0f438d5bf3d

FROM ${NODE_IMAGE} AS web
# The pinned wallet core is a public Git dependency. Resolve npm's GitHub
# SSH URL through HTTPS so clean builds need neither SSH keys nor a login.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/ && git config --global --add url."https://github.com/".insteadOf git@github.com:
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS server
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS engine
ARG BEIGNET_VERSION=0.38.0
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/beignet
RUN echo '{"private":true,"allowScripts":{"better-sqlite3":true}}' > package.json
RUN npm install --include=optional --omit=dev --no-audit --no-fund "beignet@${BEIGNET_VERSION}"
RUN BEIGNET_EXPECTED_VERSION="${BEIGNET_VERSION}" node -e "const p = require('beignet/package.json'); if (p.version !== process.env.BEIGNET_EXPECTED_VERSION) throw new Error('Unexpected Beignet version'); const D = require(require.resolve('better-sqlite3', { paths: [require.resolve('beignet')] })); new D(':memory:').prepare('select 1').get()"
COPY scripts/apply-engine-patches.mjs ./apply-engine-patches.mjs
RUN node ./apply-engine-patches.mjs /opt/beignet/node_modules/beignet

FROM ${NODE_IMAGE}
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION} BIND_HOST=0.0.0.0 NODE_ENV=production PUBLIC_DIR=/app/dist DATA_DIR=/data BEIGNET_BIN=/opt/beignet/node_modules/beignet/dist/cli/cli.js
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates gosu && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /app/server/node_modules ./server/node_modules
COPY server ./server
COPY --from=engine /opt/beignet /opt/beignet
COPY --from=web /app/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
