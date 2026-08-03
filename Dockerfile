# Island Settlers — the multiplayer server.
#
# There is nothing to build. The whole project is plain ES modules with no
# bundler, no TypeScript and no dependencies, so this image is "a Node runtime
# with the repo in it" and the build takes about two seconds.
#
# The server reaches back into ../src for the game rules — it runs the SAME
# rules.js the browser does — so the whole repo is copied, not just server/.
FROM node:22-alpine

# Runs unprivileged. The node image already provides the `node` user; the data
# directory has to belong to it or the first account written is the last.
WORKDIR /app
COPY . .
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA=/data

EXPOSE 8080

# No init system and no process manager: one process, and the platform's job
# is to restart it. SIGTERM is handled in server/index.mjs, which flushes the
# accounts to disk before exiting.
CMD ["node", "server/index.mjs"]
