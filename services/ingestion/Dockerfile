# Multi-stage build. The runtime stage carries production dependencies only and
# runs as a non-root user, which is part of the secure deployment requirement.
FROM node:22-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/ingestion/package.json services/ingestion/

# --omit=dev keeps build tooling and nodemon out of the shipped image.
RUN npm ci --omit=dev --workspace @pdm/ingestion --include-workspace-root

FROM node:22-alpine AS runtime

# dumb-init reaps zombies and forwards SIGTERM, so ECS task draining is clean.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY packages/shared ./packages/shared
COPY services/ingestion ./services/ingestion

USER node
EXPOSE 3001

HEALTHCHECK --interval=20s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "services/ingestion/src/server.js"]
