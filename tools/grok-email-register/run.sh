#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export CFMAIL_BASE="${CFMAIL_BASE:-https://mailapi.icmk.top}"
export CFMAIL_ADMIN_PASSWORD="${CFMAIL_ADMIN_PASSWORD:-2434981942a@A}"
export CFMAIL_DOMAINS="${CFMAIL_DOMAINS:-icmk.top}"
cd "$DIR"
PY="${DIR}/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "缺少虚拟环境，先执行："
  echo "  cd \"$DIR\" && python3 -m venv .venv && .venv/bin/pip install curl_cffi requests"
  exit 1
fi
exec "$PY" register.py --pretty "$@"
