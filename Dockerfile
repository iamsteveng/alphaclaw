FROM node:22-slim

RUN apt-get update && apt-get install -y git curl procps python3 make g++ cron tini jq && rm -rf /var/lib/apt/lists/*

# Install gh CLI via official GitHub apt repo (separate layer for cache efficiency)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
      https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Separate layer — Chromium is ~95 MB; keeping it isolated prevents a base-tool change from re-downloading it
RUN apt-get update && apt-get install -y chromium \
 && rm -rf /var/lib/apt/lists/*

# Install Bun via official image (pinned, avoids curl|bash supply-chain risk)
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun
ENV BUN_INSTALL=/usr/local

WORKDIR /app

# Install all deps (dev included) — needed to build the UI bundle
COPY package.json package-lock.json ./
RUN npm ci --prefer-online

RUN npm install -g @anthropic-ai/claude-code@2.1.133 \
 && claude --version
ENV CLAUDE_CONFIG_DIR=/data/.claude

# oh-my-claudecode (OMC) — multi-agent orchestration layer for Claude Code.
# Installed globally here; entrypoint.sh runs its installer with HOME=/data at boot
# so its config lands in the persisted /data/.claude (see CLAUDE_CONFIG_DIR above).
RUN npm install -g oh-my-claudecode@0.2.15 \
 && oh-my-claudecode --version

ENV PATH="/app/node_modules/.bin:$PATH"
ENV ALPHACLAW_ROOT_DIR=/data

# Clone and link gbrain — pinned to commit SHA for reproducible builds
RUN git clone https://github.com/garrytan/gbrain.git /app/gbrain \
 && cd /app/gbrain \
 && git checkout 03ffc6ebdbc7dd8b29e5bfd0c3a9a6c983b54f01 \
 && bun install \
 && bun link

ENV GBRAIN_DATA_DIR=/data/gbrain
ENV GH_CONFIG_DIR=/data/.config/gh

RUN mkdir -p /data

# Copy alphaclaw source (after deps layer for better cache reuse)
COPY bin/ ./bin/
COPY lib/ ./lib/
COPY tailwind.config.cjs ./
COPY scripts/ ./scripts/

# Build the UI bundle from source (eliminates committed build artifacts in git)
RUN npm run build:ui

# Remove devDependencies — they were only needed for the UI build step
RUN npm prune --omit=dev && npm cache clean --force

# Expose alphaclaw binary globally
RUN chmod +x bin/alphaclaw.js \
 && ln -s /app/bin/alphaclaw.js /usr/local/bin/alphaclaw

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/entrypoint.sh"]
