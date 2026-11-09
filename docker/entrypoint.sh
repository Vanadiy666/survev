#!/bin/sh
set -eu
case "${CONFIG_ROLE:-}" in
    api|game) ln -sf "/config/$CONFIG_ROLE.hjson" /app/survev-config.hjson ;;
esac
exec "$@"
