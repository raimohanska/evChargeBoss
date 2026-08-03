#!/usr/bin/env bash
set -euo pipefail

# Named Docker volumes default to root:root; the container runs as node.
# The Dockerfile pre-creates these paths owned by node so fresh volumes inherit
# that, but chown anyway to repair volumes made before that change.
sudo chown node:node /home/node/.local/share/opencode
sudo chown node:node /workspaces/evChargeBoss/node_modules

npm ci

echo "post-create.sh complete."
node --version
opencode --version || true
