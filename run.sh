#!/bin/sh
# Menjalankan Kasir Smart tanpa Docker. Butuh Python 3.8+ saja.
cd "$(dirname "$0")"
export KASIR_PORT="${KASIR_PORT:-8080}"
exec python3 server.py
