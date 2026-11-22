ARG BASE_IMAGE=node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
FROM ${BASE_IMAGE} AS compile
WORKDIR /identity
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=niltavi-identity-npm,target=/root/.npm npm ci --prefer-offline --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.service.json ./
COPY src/ src/
COPY docs/en/for-agents.md docs/en/for-agents.md
COPY preview/src/theme/ preview/src/theme/
COPY web/ web/
RUN npm run build:service && npm run build:web

FROM ${BASE_IMAGE} AS production-dependencies
WORKDIR /identity
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=niltavi-identity-npm,target=/root/.npm npm ci --omit=dev --prefer-offline --ignore-scripts --no-audit --no-fund

FROM ${BASE_IMAGE}
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /identity
ENV NODE_ENV=production
COPY --from=compile /identity/package.json ./
COPY --from=production-dependencies /identity/node_modules ./node_modules
COPY --from=compile /identity/dist ./dist
COPY --from=compile /identity/web/dist ./web/dist
COPY --from=compile /identity/src/schema*.sql ./src/
USER node
EXPOSE 8443
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
