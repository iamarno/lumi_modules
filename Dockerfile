# Carrier image for lumi feature modules.
#
# This image is NOT a runnable app. It is used as a Kubernetes init container
# that copies the compiled modules (+ their module-only deps) into a shared
# volume which the lumi core pod mounts at LUMI_MODULES_DIR.
#
#   initContainers:
#     - image: ghcr.io/iamarno/lumi_modules:<tag>
#       command: ["sh", "-c", "cp -a /modules/. /shared/"]

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24-slim AS builder

# git is needed to install the `lumi` git dependency
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# lockfile pins the lumi git dep to an exact commit
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: production deps ──────────────────────────────────────────────────
FROM node:24-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
# prod node_modules = axios only: dev toolchain and host-provided peers
# (matrix-js-sdk — supplied by the core image at runtime) are excluded
RUN npm ci --omit=dev --omit=peer

# ── Stage 3: carrier ──────────────────────────────────────────────────────────
FROM busybox:stable AS runtime

# OCI image labels (values injected by CI via --build-arg)
ARG VERSION=dev
ARG REVISION=unknown
ARG BUILD_DATE=unknown
ARG REPO=local/lumi_modules

LABEL org.opencontainers.image.title="lumi_modules" \
      org.opencontainers.image.description="Feature modules for the lumi Matrix bot (init-container carrier)" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/${REPO}" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /modules
COPY --from=builder /app/dist         ./
COPY --from=deps    /app/node_modules ./node_modules

# No CMD needed — the init container overrides the command with a cp.
