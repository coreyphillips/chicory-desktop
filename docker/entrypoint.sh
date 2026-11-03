#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/data}"

# Docker creates a missing bind-mount source dir as root, so ensure the data
# volume exists and is owned by the unprivileged app user before we drop to it.
mkdir -p "$DATA_DIR/wallets"
chown -R 1000:1000 "$DATA_DIR"

# Run the manager as UID 1000 (the beignet child daemons inherit this).
exec gosu 1000:1000 node /app/server/index.js
