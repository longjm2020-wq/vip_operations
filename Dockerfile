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
# Arbitrary assistant pages require Chromium's real Linux sandbox. Keep the
# runtime unprivileged; a host that cannot create the sandbox reports unavailable.
RUN chown -R node:node /app \
    && chmod -R a+rX /ms-playwright
# Drop privileges at the entry point as well as for all service children. This
# keeps the non-root runtime compatible with hosts that select their container
# security profile from the image's initial user; sandbox support is still
# checked by the worker and never disabled.
ENTRYPOINT ["runuser", "-u", "node", "--"]
CMD ["sh", "-c", "pnpm db:migrate && pnpm start:api"]
