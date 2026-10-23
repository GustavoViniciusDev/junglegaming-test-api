FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY tsconfig*.json mikro-orm.config.ts ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.4.4 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/bun.lock ./
RUN bun install --production --frozen-lockfile
COPY --from=build /app/dist ./dist
USER bun
EXPOSE 3000
CMD ["bun", "dist/src/main.js"]
