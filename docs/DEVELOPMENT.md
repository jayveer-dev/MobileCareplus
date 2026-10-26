# Developing Mobile Care Plus

Mobile Care Plus is an Electron app written in TypeScript and React. It talks to phones through small
command-line tools: [libimobiledevice](https://libimobiledevice.org) for iPhones and Android's `adb`.

## Get it running (macOS)

You need [Node.js](https://nodejs.org) 22 or newer, Xcode's command-line tools (`xcode-select --install`)
and [Homebrew](https://brew.sh).

```bash
brew install libimobiledevice ideviceinstaller android-platform-tools ffmpeg
npm ci                     # installs dependencies and downloads Electron
./scripts/build-native.sh  # builds the helper tools into resources/bin/darwin
npm run dev                # starts the app with hot reload
```

Connect a phone (iPhone: unlock and tap Trust; Android: turn on USB debugging) and it appears in the app.

## Checks

```bash
npm test           # unit tests (node --test)
npm run typecheck  # TypeScript
```

Tests use made-up data only. Never put real phone numbers, names, device IDs or photos in tests,
fixtures or screenshots.

## Project layout

| Path | What's there |
|---|---|
| `src/main/` | Main process: everything that talks to phones, reads backups and writes files |
| `src/preload/` | The bridge exposing main-process features to each window |
| `src/renderer/` | The windows: `index.html` (main app) and `transfer.html` (Mobile Care Plus Transfer) |
| `src/shared/types.ts` | Types shared by all three |
| `native/` | Helper tools in C/Objective-C: `ddbackup` (selective iPhone backups), `ddicons` (iPhone app icons), `ddphotos` (iPhone photo delete, macOS) |
| `native/win/` | Recipe for building the helpers for Windows |
| `build/` | App icon (`icon.svg` is the source) |
| `docs/` | Design notes, e.g. [TRANSFER-DESIGN.md](TRANSFER-DESIGN.md) |

Tools are found in `resources/bin/<platform>/` first (bundled with installers), then on `PATH`
(`src/main/tools.ts`). That folder is built locally and never committed.

## Building the Mac app

```bash
./scripts/build-native.sh       # our helpers
./scripts/bundle-mac-tools.sh   # copies the Homebrew tools and their libraries into the app
npm run package:mac             # dist/Mobile-Care-Plus-<version>-mac-arm64.dmg and .zip
```

`bundle-mac-tools.sh` rewires every library to load from inside the app and re-signs it, so the app
runs on Macs without Homebrew. The result runs on the macOS version Homebrew built the tools for
(and newer), on Apple Silicon. The app is ad-hoc signed, not notarized.

## Building the Windows installer

The Windows installer can be built on a Mac. It needs Windows builds of every tool in
`resources/bin/win32/`:

1. **adb**: `adb.exe`, `AdbWinApi.dll` and `AdbWinUsbApi.dll` from Google's
   [platform-tools for Windows](https://developer.android.com/tools/releases/platform-tools).
2. **libimobiledevice tools and their DLLs**: from the [MSYS2](https://packages.msys2.org) `ucrt64`
   packages `mingw-w64-ucrt-x86_64-libimobiledevice`, `-ideviceinstaller` and `-libplist` plus their
   dependencies. Copy `idevice_id`, `ideviceinfo`, `idevicepair`, `idevicebackup2`, `idevicediagnostics`,
   `ideviceinstaller`, `plistutil` and `idevicescreenshot` (`.exe`) and every `.dll` from the packages'
   `ucrt64/bin`.
3. **Our helpers** (`afcclient`, `ddbackup`, `ddicons`): run `native/win/build.sh WORKDIR`. It cross-compiles
   them with [Zig](https://ziglang.org) 0.14.1 against libimobiledevice 1.4.0. WORKDIR holds the unpacked Zig
   release, the libimobiledevice 1.4.0 source, and the MSYS2 packages unpacked into `WORKDIR/ext`; see the
   script's header.

Then:

```bash
npm run package:win   # dist/Mobile-Care-Plus-Setup-<version>.exe
```

The installer isn't code-signed yet.
