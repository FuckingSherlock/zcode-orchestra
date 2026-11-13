# Сборка TS → dist отдельным этапом: devDependencies (typescript) не попадают в рантайм-образ
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Рантайм: только prod-зависимости + глобальный zcode CLI
FROM node:22-slim
WORKDIR /app
# неофициальный CLI ZCode (zcode-app-cli) — спавнится runner'ом
RUN npm install -g zcode-app-cli@latest
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production \
    ORCHESTRA_TRANSPORT=http \
    ORCHESTRA_PORT=8787 \
    ORCHESTRA_WORKDIR_ROOT=/workspace \
    ORCHESTRA_DATA_DIR=/app/data

EXPOSE 8787
CMD ["node", "dist/index.js"]
