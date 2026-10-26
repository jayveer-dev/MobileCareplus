#!/bin/sh
# Builds Mobile Care Plus's small native helpers into resources/bin/<platform>/ (macOS, Homebrew libimobiledevice).
# macOS only. Windows builds come from native/win/build.sh (see docs/DEVELOPMENT.md).
set -e
cd "$(dirname "$0")/.."
OUT=resources/bin/darwin
mkdir -p "$OUT"
IMD=$(brew --prefix libimobiledevice)
PL=$(brew --prefix libplist)
GLUE=$(brew --prefix libimobiledevice-glue)
INC="-I$IMD/include -I$PL/include -I$GLUE/include"
LIB="-L$IMD/lib -L$PL/lib -L$GLUE/lib -limobiledevice-1.0 -lplist-2.0"

# App icons over the springboard service.
clang -O2 -Wall -o "$OUT/ddicons" native/ddicons.c $INC $LIB
echo "built $OUT/ddicons"

# Backup receiver with the keep-list filter (libimobiledevice's idevicebackup2, LGPL-2.1, modified).
clang -O2 -Wall -Wno-unused -DHAVE_CONFIG_H -Inative/ddbackup -o "$OUT/ddbackup" native/ddbackup/ddbackup.c $INC $LIB -limobiledevice-glue-1.0
echo "built $OUT/ddbackup"

# Photo delete through ImageCaptureCore, so the iPhone's Photos app removes the items itself.
clang -O2 -Wall -fobjc-arc -o "$OUT/ddphotos" native/ddphotos.m -framework Foundation -framework ImageCaptureCore
echo "built $OUT/ddphotos"
