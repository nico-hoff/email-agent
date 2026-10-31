FROM node:26.12.1-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
ENV NODE_ENV=production
# Started as root (fly.io: the volume is mounted root-owned), the entrypoint fixes /data and drops to node;
# started as node (Compose) it runs the command directly. See docs/fly-deploy.md.
ENTRYPOINT ["sh", "/app/scripts/docker-entrypoint.sh"]
CMD ["npm","start"]

# fly.io target (fly.toml: build-target = "fly"): no USER, the entrypoint switches to node after fixing /data.
FROM base AS fly
# node directly instead of npm start: the npm and sh wrappers cost about 100 MB RSS (measured), which matters on a 512 MB VM.
# The heap cap keeps V8 from growing into the VM's memory (measured peak with the cap: about 270 MB RSS under load).
CMD ["node", "--max-old-space-size=256", "server.ts", "--production"]

# Default (last) target, used by Compose and the Docker smoke: unprivileged from the start.
FROM base AS app
USER node
