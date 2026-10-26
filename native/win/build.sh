#!/bin/sh
# Builds afcclient, ddbackup and ddicons for Windows x64 with zig (cross-compiling from macOS):
# libimobiledevice 1.4.0 is compiled into each tool; libplist, libusbmuxd, glue and OpenSSL come
# from MSYS2 ucrt64 DLLs that ship next to them (same UCRT runtime, so memory crosses safely).
set -e
# Usage: native/win/build.sh WORKDIR  (WORKDIR holds zig, the libimobiledevice 1.4.0 source and the unpacked MSYS2 packages in ext/)
W="${1:?work dir}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ZIG="$W/zig-aarch64-macos-0.14.1/zig"
L="$W/libimobiledevice-1.4.0"
DD="$HERE/.."
OUT="$HERE/../../resources/bin/win32"
mkdir -p "$OUT"
SRC=""
for f in "$L"/src/*.c "$L"/common/*.c; do
  case "$f" in *lockdown-cu.c) continue;; esac   # wireless pairing (needs 3rd_party srp/ed25519); not used
  SRC="$SRC $f"
done
CFLAGS="-target x86_64-windows-gnu -O2 -DHAVE_CONFIG_H -DLIBIMOBILEDEVICE_STATIC -I$HERE -I$L -I$L/include -I$L/common -I$L/src -I$W/ext/ucrt64/include -w"
LIBS="$W/ext/ucrt64/lib/libimobiledevice-glue-1.0.dll.a $W/ext/ucrt64/lib/libusbmuxd-2.0.dll.a $W/ext/ucrt64/lib/libplist-2.0.dll.a $W/ext/ucrt64/lib/libssl.dll.a $W/ext/ucrt64/lib/libcrypto.dll.a -lws2_32 -liphlpapi -lcrypt32 -lbcrypt -ladvapi32 -luser32 -lgdi32 -lole32 -lshell32"
build() { name=$1; shift; echo "== $name"; "$ZIG" cc $CFLAGS -o "$OUT/$name.exe" "$@" $SRC $LIBS; }
build afcclient "$L/tools/afcclient.c"
build ddbackup -I"$DD/ddbackup" "$DD/ddbackup/ddbackup.c"
build ddicons "$DD/ddicons.c"
ls -la "$OUT"
