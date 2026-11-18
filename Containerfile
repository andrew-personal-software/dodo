# dodo's image. hawk builds it on the box: podman build --build-arg VERSION=<v>. hawk passes the command (deploy/hawk.json).
FROM docker.io/library/node:24-slim AS build
WORKDIR /app
ENV CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG VERSION=0.0.0
RUN pnpm pkg set version="$VERSION" && pnpm build && pnpm prune --prod

FROM docker.io/library/node:24-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/dist ./dist
