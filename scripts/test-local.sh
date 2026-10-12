#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for node_runtime in .runtime/node-v24*-darwin-*/bin/node; do
  if [ -x "$node_runtime" ]; then exec "$node_runtime" scripts/test-server.mjs "${1:-status}"; fi
done
printf '%s\n' '未找到项目内 Node.js 24，请检查 .runtime/ 目录。' >&2
exit 1
