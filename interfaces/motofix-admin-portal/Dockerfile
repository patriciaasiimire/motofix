# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* bun.lockb* ./
RUN npm install

# Vite env vars are baked in at build time — pass them as build args
ARG VITE_API_BASE_URL=http://localhost:8005
ARG VITE_API_AUTH_URL=http://localhost:8000
ARG VITE_API_REQUESTS_URL=http://localhost:8001
ARG VITE_API_MECHANICS_URL=http://localhost:8000/auth
ARG VITE_API_ADMIN_URL=http://localhost:8005

ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_API_AUTH_URL=$VITE_API_AUTH_URL
ENV VITE_API_REQUESTS_URL=$VITE_API_REQUESTS_URL
ENV VITE_API_MECHANICS_URL=$VITE_API_MECHANICS_URL
ENV VITE_API_ADMIN_URL=$VITE_API_ADMIN_URL

COPY . .
RUN npm run build

# ── Stage 2: serve ─────────────────────────────────────────────────────────────
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
