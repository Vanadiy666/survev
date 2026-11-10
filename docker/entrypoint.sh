#!/bin/sh
set -eu
if [ "${1:-}" = configure ]; then
    chown -R node:node /config /app/server/lost_game_data
    # File secrets retain host permissions, including owner-only read access.
    source_file=$(mktemp)
    trap 'rm -f "$source_file"' EXIT HUP INT TERM
    cp /run/secrets/survev_config "$source_file"
    chown node:node "$source_file"
    chmod 600 "$source_file"
    CONFIG_SOURCE="$source_file" gosu node node /app/docker/config.mjs
    exit 0
fi
case "${CONFIG_ROLE:-}" in
    api|game) ln -sf "/config/$CONFIG_ROLE.hjson" /app/survev-config.hjson ;;
esac
exec "$@"
