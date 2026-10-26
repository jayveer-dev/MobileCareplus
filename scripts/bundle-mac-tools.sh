#!/bin/bash
# Copies the phone tools Mobile Care Plus uses into resources/bin/darwin, together with every
# Homebrew library they need, rewired to load from there (@loader_path) and ad-hoc signed again, so
# the packaged app works on Macs without Homebrew. Run after scripts/build-native.sh.
# Apple Silicon (arm64): Homebrew's libraries on this machine are arm64 only.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=resources/bin/darwin
LIB="$OUT/lib"
mkdir -p "$LIB"

TOOLS="idevice_id ideviceinfo idevicepair idevicebackup2 idevicediagnostics ideviceinstaller plistutil idevicescreenshot afcclient adb"
for t in $TOOLS; do
  src=$(command -v "$t") || { echo "missing $t (brew install libimobiledevice ideviceinstaller android-platform-tools)"; exit 1; }
  cp -f "$(realpath "$src")" "$OUT/$t"
  chmod u+w "$OUT/$t"
done

# Libraries outside the system: Homebrew prefixes, or @rpath names resolved against Homebrew.
homebrew_deps() { otool -L "$1" | tail -n +2 | awk '{print $1}' | grep -E '^(/opt/homebrew|/usr/local|@rpath)/' || true; }
resolve() {
  case "$1" in
    @rpath/*) ls /opt/homebrew/lib/"$(basename "$1")" 2>/dev/null || { echo "can't resolve $1" >&2; exit 1; } ;;
    *) echo "$1" ;;
  esac
}

# Breadth-first over our helpers, the tools, then each library pulled in.
queue=$(mktemp)
for f in "$OUT"/*; do [ -f "$f" ] && file "$f" | grep -q Mach-O && echo "$f"; done > "$queue"
changed=$(mktemp)
i=1
while f=$(sed -n "${i}p" "$queue") && [ -n "$f" ]; do
  i=$((i + 1))
  for dep in $(homebrew_deps "$f"); do
    base=$(basename "$dep")
    if [ ! -f "$LIB/$base" ]; then
      cp -f "$(realpath "$(resolve "$dep")")" "$LIB/$base"
      chmod u+w "$LIB/$base"
      install_name_tool -id "@loader_path/$base" "$LIB/$base" 2>/dev/null
      echo "$LIB/$base" >> "$queue"
      echo "$LIB/$base" >> "$changed"
    fi
    case "$f" in
      "$LIB"/*) install_name_tool -change "$dep" "@loader_path/$base" "$f" 2>/dev/null ;;
      *) install_name_tool -change "$dep" "@loader_path/lib/$base" "$f" 2>/dev/null ;;
    esac
    echo "$f" >> "$changed"
  done
done

# Rewriting load commands invalidates signatures; arm64 Macs refuse to run unsigned code.
sort -u "$changed" | while read -r f; do codesign --force --sign - "$f" 2>/dev/null; done
left=$(for f in "$OUT"/* "$LIB"/*; do [ -f "$f" ] && otool -L "$f" | tail -n +2 | grep -E '/opt/homebrew|/usr/local|@rpath' || true; done)
[ -z "$left" ] || { echo "still linked outside the app:"; echo "$left"; exit 1; }
echo "bundled $(echo $TOOLS | wc -w | tr -d ' ') tools and $(ls "$LIB" | wc -l | tr -d ' ') libraries into $OUT"
rm -f "$queue" "$changed"
