# Una imagen para la web, la API y los comandos (npm run radar / npm run seed).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8116 DB_PATH=/app/data/radar.sqlite NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY seed ./seed
COPY --from=build /app/dist/web ./dist/web
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 8116
VOLUME ["/app/data"]
CMD ["node", "src/server.ts"]
