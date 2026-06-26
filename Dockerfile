FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=19829
ENV LLM_WIKI_API_BASE_URL=http://host.docker.internal:19828
ENV LLM_WIKI_PROXY_TIMEOUT_MS=30000
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
EXPOSE 19829
CMD ["node", "server/index.mjs"]
