FROM docker.io/library/node:20-alpine AS builder
RUN npm install -g pnpm
WORKDIR /app
COPY package.json ./ 
RUN npx pnpm install
COPY . .
RUN npx prisma generate
ARG DATABASE_URL=postgresql://user:password@db:5432/dbname?schema=public
ENV DATABASE_URL=${DATABASE_URL}
ENV NODE_ENV production
ENV SKIP_REDIS_CONNECTION=true 
RUN pnpm run build
ENV SKIP_REDIS_CONNECTION=false
FROM node:20-alpine AS runner
ENV NODE_ENV production
WORKDIR /app
COPY --from=builder /app/next.config.ts ./
COPY --from=builder /app/package.json ./
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]