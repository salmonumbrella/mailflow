# mailflow-mcp in HTTP mode. Any Node 20+ image works; override the base for hosts whose kernel
# cannot run the newest Alpine packages, e.g. --build-arg NODE_BASE=node:22-bookworm-slim.
ARG NODE_BASE=node:22-alpine
FROM ${NODE_BASE}

WORKDIR /app
ENV NODE_ENV=production \
    MCP_HTTP_HOST=0.0.0.0

COPY package.json package-lock.json ./
# No dependency needs an install script, so none is allowed to run.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src

USER node
EXPOSE 8787
# Node's own fetch: slim images have neither wget nor curl. /healthz is healthy only while
# MailFlow's /api/health answers, so a lost backend makes the container unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.MCP_HTTP_PORT || 8787) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/cli.js", "http"]
