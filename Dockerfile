# Island Settlers — the multiplayer server.
#
# There is nothing to build. The whole project is plain ES modules with no
# bundler, no TypeScript and no dependencies, so this image is "a Node runtime
# with the repo in it" and the build takes about two seconds.
#
# The server reaches back into ../src for the game rules — it runs the SAME
# rules.js the browser does — so the whole repo is copied, not just server/.
FROM node:22-alpine

# STARTS AS ROOT AND DOES NOT STAY THERE.
#
# `USER node` here looks like the careful choice and is the wrong one: a
# platform hands a container its volume owned by root, so a process that is
# already unprivileged cannot write to the one directory it exists to write to.
# On the first Railway deploy that showed up as a server that ran perfectly and
# recorded zero writes — every account would have vanished at the next deploy.
#
# So server/index.mjs claims the data directory and calls setgid/setuid itself,
# before it opens a socket. Nothing that touches the network runs as root. See
# claimDataAndDropPrivileges() there; RUN_AS overrides who it becomes.
WORKDIR /app
COPY . .
RUN chown -R node:node /app

ENV NODE_ENV=production

# NO PORT AND NO DATA BAKED IN, DELIBERATELY.
#
# Railway injects PORT at runtime and publishes RAILWAY_VOLUME_MOUNT_PATH for
# whatever path the volume was actually mounted at. An ENV here would be a
# second opinion about both, and the DATA one is the dangerous half: point it
# at a path that is not the mount and the accounts file writes happily to the
# container's own disk and disappears with it on the next deploy.
#
# server/index.mjs falls back to its own sensible defaults (8787, and a folder
# beside itself) so `docker run` with no environment still works, and fly.toml
# pins both explicitly because Fly does not publish either.
EXPOSE 8787

# No init system and no process manager: one process, and the platform's job
# is to restart it. SIGTERM is handled in server/index.mjs, which flushes the
# accounts to disk before exiting.
CMD ["node", "server/index.mjs"]
