#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js 20+ is required"; exit 1; }
[ -f .env ] || cp .env.example .env
npm install
npm run db:init
npm run doctor
npm run dev:core
