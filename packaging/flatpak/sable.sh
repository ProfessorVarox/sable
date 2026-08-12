#!/bin/sh
# zypak lets CEF's sandbox work under Flatpak without a setuid chrome-sandbox.
export ZYPAK_CEF_LIBRARY_PATH=/app/extra/sable/libcef.so
exec zypak-wrapper /app/extra/sable/sable "$@"
