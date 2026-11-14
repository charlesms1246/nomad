# Nomad matcher container (build from the repo root):
#   docker build -f apps/matcher/Dockerfile -t nomad-matcher .
# Modes (MODE env):
#   sim   (default) continuous simulation behind /api/state. No keys, no chain.
#   live  matcher + in-process agents on our testnet Verifier. Needs keys mounted (see docs/DEPLOY.md).
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/agent ./apps/agent
COPY apps/matcher ./apps/matcher
COPY config ./config
COPY RULES.md ./
RUN pnpm install --frozen-lockfile --filter "./packages/*" --filter "./apps/*" \
 && pnpm -r --filter "./packages/*" --filter "./apps/*" build
ENV NODE_OPTIONS=--dns-result-order=ipv4first HOST=0.0.0.0 PORT=8080 MODE=sim PUBLIC=1
EXPOSE 8080
WORKDIR /app/apps/matcher
CMD ["sh", "-c", "if [ \"$MODE\" = live ]; then exec pnpm exec tsx src/cli-live.ts; else SWEEP=0 SERVE=1 exec pnpm exec tsx src/cli-sim.ts; fi"]
