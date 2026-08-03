# Island Settlers — the multiplayer server.
#
# There is nothing to build. The whole project is plain ES modules with no
# bundler, no TypeScript and no dependencies, so this image is "a Node runtime
# with the repo in it" and the build takes about two seconds.
#
# The server reaches back into ../src for the game rules — it runs the SAME
# rules.js the browser does — so the whole repo is copied, not just server/.
FROM node:22-alpine

# UNPRIVILEGED, AND NOW IT CAN BE.
#
# This used to start as root so the process could chown a mounted volume and
# then drop privileges itself — the volume held the accounts file, platforms
# mount volumes owned by root, and an already-unprivileged process could not
# write to the one directory it existed to write to.
#
# There is no accounts file any more. Rooms are five-character codes and a
# player is a device id their own browser remembers, so the server keeps
# everything in memory and never touches a disk. No volume, no chown, no
# privilege dance, and no volume needs attaching to this service.
WORKDIR /app
COPY . .
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production

# NO PORT BAKED IN, DELIBERATELY. Railway injects PORT at runtime; an ENV here
# would be a second opinion about it. server/index.mjs falls back to 8787 so
# `docker run` with no environment still works.
EXPOSE 8787

# No init system and no process manager: one process, and the platform's job
# is to restart it. SIGTERM is handled in server/index.mjs, which stops the
# match workers before exiting. Nothing is flushed, because nothing is stored.
CMD ["node", "server/index.mjs"]
