FROM node:24.21.0-bookworm-slim
WORKDIR /app
RUN apt-get update -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends ffmpeg openssl \
    && rm -rf /var/lib/apt/lists/*
ENV FFMPEG_BIN=/usr/bin/ffmpeg
RUN npm install -g pnpm@10.32.1
COPY . .
RUN pnpm install --frozen-lockfile
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm exec playwright install --with-deps chromium --only-shell
RUN pnpm db:generate \
    && pnpm exec vitest run tests/unit/assistant-agent-media.test.ts --maxWorkers=1 \
    && pnpm build
CMD ["sh", "-c", "pnpm db:migrate && pnpm start:api"]
