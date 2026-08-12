#!/usr/bin/env bash
#MISE description="Package the CEF build into an AppImage"
#MISE tools={"github:AppImage/appimagetool" = {version = "1.9.1", matching = ".AppImage"}}
# deb/rpm/archlinux/snap come from GoReleaser.
# Usage: scripts/cef/package.sh [version] [binary-path] [display-name]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(grep -m1 '"version":' src-tauri/tauri.conf.json | sed 's/.*: *"\(.*\)".*/\1/')}"
: "${VERSION:?version not found in src-tauri/tauri.conf.json}"

STAGE="$ROOT/src-tauri/target/release"
OUT="$STAGE/bundle"
WORK="$STAGE/cef-pkg"

BIN_PATH="${2:-}"
DISPLAY_NAME="${3:-}"
if [ -z "$BIN_PATH" ]; then
  for candidate in "$STAGE/Sable Nightly" "$STAGE/Sable" "$STAGE/sable" \
    "$ROOT/src-tauri/target/x86_64-unknown-linux-gnu/release/sable"; do
    [ -x "$candidate" ] || continue
    BIN_PATH="$candidate"
    break
  done
fi
[ -n "$BIN_PATH" ] && [ -x "$BIN_PATH" ] || {
  echo "no CEF binary found; build it first (pnpm tauri:cef build)" >&2
  exit 1
}
if [ -z "$DISPLAY_NAME" ]; then
  case "$(basename "$BIN_PATH")" in
    "Sable Nightly") DISPLAY_NAME="Sable Nightly" ;;
    *) DISPLAY_NAME="Sable" ;;
  esac
fi

APPIMAGETOOL_CMD=""
if command -v appimagetool.AppImage >/dev/null 2>&1; then
  APPIMAGETOOL_CMD="appimagetool.AppImage"
elif command -v appimagetool >/dev/null 2>&1; then
  APPIMAGETOOL_CMD="appimagetool"
else
  echo "appimagetool not found" >&2
  exit 1
fi

rm -rf "$WORK"
mkdir -p "$OUT/appimage"

bash scripts/cef/stage.sh "$WORK/stage" "$DISPLAY_NAME"

APPDIR="$WORK/Sable.AppDir"
mkdir -p "$APPDIR/usr/bin"
cp -a "$WORK/stage/runtime/." "$APPDIR/usr/bin/"
cp -f "$BIN_PATH" "$APPDIR/usr/bin/sable"
chmod 755 "$APPDIR/usr/bin/sable"

# Bundle the system-tray libraries (Tauri's linuxdeploy path normally does this,
# which the CEF build bypasses). Bundle libayatana-appindicator3 plus its
# ayatana/dbusmenu/indicator dependency closure; host libs (gtk, glib, X11, …)
# are left to the system, matching linuxdeploy-plugin-appindicator.
stage_appindicator() {
  local dest="$1" main dep
  # awk reads to EOF (no early exit) so ldconfig never gets SIGPIPE under pipefail.
  main="$(ldconfig -p 2>/dev/null | awk '$1=="libayatana-appindicator3.so.1"{v=$NF} END{print v}')"
  [ -n "$main" ] || main="$(find /usr/lib /usr/lib64 /lib -name libayatana-appindicator3.so.1 2>/dev/null | sort | tail -n1)"
  if [ -z "$main" ] || [ ! -e "$main" ]; then
    echo "warning: libayatana-appindicator3.so.1 not found; tray disabled in the AppImage" >&2
    return 0
  fi
  {
    echo "$main"
    ldd "$main" 2>/dev/null | awk '/=>/ {print $3}' | grep -iE 'ayatana|dbusmenu|indicator|ido' || true
  } | sort -u | while read -r dep; do
    if [ -e "$dep" ]; then
      cp -Lf "$dep" "$dest/$(basename "$dep")"
    fi
  done
}
stage_appindicator "$APPDIR/usr/bin"

cp -f "$WORK/stage/share/applications/sable.desktop" "$APPDIR/sable.desktop"
cp -f src-tauri/icons/128x128.png "$APPDIR/sable.png"
cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
export LD_LIBRARY_PATH="$HERE/usr/bin${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$HERE/usr/bin/sable" "$@"
EOF
chmod 755 "$APPDIR/AppRun"

APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 "$APPIMAGETOOL_CMD" "$APPDIR" \
  "$OUT/appimage/Sable-${VERSION}-linux-x86_64.AppImage"

echo "AppImage in: $OUT/appimage"
