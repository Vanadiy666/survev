#!/bin/sh
set -eu
# Docker may create new bind-mount directories owned by root on Linux.
# Prepare only the application data directories, then drop privileges.
chown -R node:node /config /app/server/lost_game_data
exec gosu node node /app/docker/config.mjs
