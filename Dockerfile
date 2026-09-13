FROM node:24.21.0-bookworm-slim
WORKDIR /app
RUN npm install -g pnpm@10.32.1
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm db:generate && pnpm build
CMD ["pnpm", "start:api"]
