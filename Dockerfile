FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY scripts ./scripts
RUN npm ci --registry=https://registry.npmjs.org
COPY tsconfig.json ./
COPY src ./src
COPY apps/web ./apps/web
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.232
RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --registry=https://registry.npmjs.org \
       "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" pnpm@9.15.4
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY config ./config
COPY docker-entrypoint.sh /usr/local/bin/frontend-pilot-entrypoint
RUN chmod 0755 /usr/local/bin/frontend-pilot-entrypoint
ENV NODE_ENV=production \
    HOME=/app/var \
    WEB_DIST_DIR=/app/apps/web/dist \
    REVIEW_RULES_DIR=/app/var/review-rules \
    REVIEW_PROFILE_CONFIG=/app/var/review-profiles.json \
    INSPECTION_RULES_DIR=/app/var/review-rules/inspection \
    INSPECTION_PROFILE_CONFIG=/app/var/inspection-profiles.json \
    REVIEW_DATABASE_PATH=/app/var/frontend-pilot.sqlite \
    REVIEW_WORKSPACE_DIR=/app/var/review-workspaces
WORKDIR /app/var
EXPOSE 8080
VOLUME ["/app/var"]
ENTRYPOINT ["/usr/local/bin/frontend-pilot-entrypoint"]
CMD ["node", "/app/dist/src/server.js"]
