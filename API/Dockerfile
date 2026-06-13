# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS contracts-build

WORKDIR /workspace/contracts

COPY contracts/package.json contracts/package-lock.json ./
RUN npm ci --ignore-scripts

COPY contracts/tsconfig.json ./
COPY contracts/*.ts ./
RUN npm run typecheck && npm run build

FROM node:20-bookworm-slim AS api-build

WORKDIR /workspace

COPY --from=contracts-build /workspace/contracts ./contracts
COPY API/package.json API/package-lock.json ./API/

WORKDIR /workspace/API
RUN npm ci --ignore-scripts

COPY API/tsconfig.json ./
COPY API/src ./src
RUN npm run typecheck && npm run build
RUN npm prune --omit=dev --ignore-scripts \
  && rm -rf node_modules/@eszter/contracts \
  && npm cache clean --force

FROM node:20-bookworm-slim AS production

LABEL org.opencontainers.image.title="Eszter API"
LABEL org.opencontainers.image.description="Express API for the Eszter CMS backend"

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000
ENV LOG_LEVEL=info
ENV CONTENT_DATA_DIR=/data

WORKDIR /app

COPY --chown=node:node API/package.json API/package-lock.json ./
COPY --from=api-build --chown=node:node /workspace/API/dist ./dist
COPY --from=api-build --chown=node:node /workspace/API/node_modules ./node_modules

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 4000
VOLUME ["/data"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
