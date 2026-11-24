# PiFi signaling server image.
#
# Build from the REPOSITORY ROOT, not from packages/server/: the server imports the
# shared packages/protocol workspace, which is outside this folder.
#
#   docker build -f packages/server/Dockerfile -t pifi-signal .
#   docker run --rm -p 8080:8080 pifi-signal
#
# The root .dockerignore keeps node_modules, .git, keys/ and *.token out of the context.

# ---- build stage: compile TypeScript ----
FROM node:22-slim AS build
WORKDIR /app
# Every workspace's package.json is copied so `npm ci` sees a tree matching package-lock.json.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/runtime/package.json packages/runtime/
COPY packages/sdk/package.json packages/sdk/
COPY packages/signal-testclient/package.json packages/signal-testclient/
COPY packages/client/package.json packages/client/
COPY packages/shell/package.json packages/shell/
RUN npm ci --workspace=@pifi/server --include-workspace-root
COPY packages/protocol/tsconfig.json packages/protocol/
COPY packages/protocol/src packages/protocol/src
COPY packages/server/tsconfig.json packages/server/
COPY packages/server/src packages/server/src
RUN npx tsc -b packages/server

# ---- runtime stage: production dependencies + compiled JS only ----
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/runtime/package.json packages/runtime/
COPY packages/sdk/package.json packages/sdk/
COPY packages/signal-testclient/package.json packages/signal-testclient/
COPY packages/client/package.json packages/client/
COPY packages/shell/package.json packages/shell/
RUN npm ci --omit=dev --workspace=@pifi/server && npm cache clean --force
COPY --from=build /app/packages/protocol/dist/src packages/protocol/dist/src
COPY --from=build /app/packages/server/dist/src packages/server/dist/src

# Never run as root. The official image ships an unprivileged `node` user.
USER node
WORKDIR /app/packages/server
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
