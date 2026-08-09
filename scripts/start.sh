#!/bin/bash
# Backwards-compatible launcher. Prefer: ./shared-browser launch [options]
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "${SCRIPT_DIR}/../shared-browser" launch "$@"
