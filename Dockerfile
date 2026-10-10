# syntax=docker/dockerfile:1

# ---- build stage -------------------------------------------------------------
FROM node:22-slim AS build
# git: fetch the storelint scanner from GitHub. python3/make/g++: build better-sqlite3 if no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
# The scanner (optionalDependencies.storelint -> github:iddriss/storelint) can only enter the lockfile once
# that repo is public; until then a frozen install is rejected. Fall back to a non-frozen install, which still
# pins every other package from the lockfile and skips the scanner when GitHub returns 404.
RUN pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile
# Fetch the scanner explicitly so a freshly pushed repo is picked up on every rebuild; tolerate it being absent
# (the app then falls back to its stub scanner and says so on the landing page).
RUN pnpm add storelint@github:iddriss/storelint || echo "storelint not available yet; building with the stub scanner"

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN pnpm build && pnpm prune --prod

# ---- runtime stage -----------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
