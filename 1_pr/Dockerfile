# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY prisma nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src

ARG DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
ENV DATABASE_URL=${DATABASE_URL}

RUN pnpm exec prisma generate && pnpm run build

FROM node:22-alpine AS runner
WORKDIR /app
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY prisma ./prisma
COPY --from=builder /app/dist ./dist

ARG DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
ENV DATABASE_URL=${DATABASE_URL}
RUN pnpm exec prisma generate

ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/main.js"]
