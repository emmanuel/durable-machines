FROM node:24-slim AS build
RUN corepack enable && corepack prepare pnpm@10.6.2 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json ./
COPY packages/ packages/
COPY examples/webhook-approval/ examples/webhook-approval/
RUN pnpm install --frozen-lockfile
RUN pnpm -r build && \
    cd examples/webhook-approval && pnpm exec tsc -p tsconfig.build.json
# Remove TypeScript source and test files
RUN find packages -name 'src' -type d -exec rm -rf {} + 2>/dev/null; \
    find packages -name 'tests' -type d -exec rm -rf {} + 2>/dev/null; \
    rm -rf examples/webhook-approval/src; \
    true

FROM node:24-slim
WORKDIR /app
COPY --from=build /app .
