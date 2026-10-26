# Mobile Care Plus Transfer: Restore and Transfer design

Status: design, 2026-10-24. Back up, View and Export for WhatsApp / WhatsApp Business on iPhone are
built (`src/main/whatsapp.ts`, `src/renderer/src/transfer/`). This document covers what is not built yet: **Restore**
and **Transfer between phones**, for WhatsApp, WhatsApp Business, GBWhatsApp, and later Kik and Viber.

Approach: on Android, chats are reached through WhatsApp's own end-to-end encrypted backup, read and
written with the user's **64-digit backup key**. To restore, the user reinstalls WhatsApp on the target so
WhatsApp itself imports the chats. Paths are listed under [Android side](#android-side).

## What each direction needs

| From → To | Pieces | Phone setup the user does | Risk |
|---|---|---|---|
| iPhone → same/other iPhone (Restore) | Saved backup → iOS restore set → restore | Find My off; WhatsApp installed and signed in with the same number | Replaces the app's data on the target |
| Android → Android | Copy encrypted backup + media | Target: install WhatsApp, restore with the same 64-digit key | Low |
| iPhone → Android | iOS reader → **converter iOS→Android** → crypt15 writer → push | Target: turn on end-to-end backup with 64-digit key, back up once, then reinstall WhatsApp after we push | Schema conversion |
| Android → iPhone | crypt15 reader → **converter Android→iOS** → iOS restore set → restore | Source: end-to-end backup with 64-digit key; target: WhatsApp installed and signed in, Find My off | Schema conversion + restore |
| GBWhatsApp | Same as Android, different package/paths | Same as Android | Same |
| Kik, Viber (iPhone) | Same as iPhone Restore, different backup domains | Same as iPhone Restore | Same |

All transfers keep WhatsApp's own rule: the chats belong to a phone number, so the target phone must sign
in with the **same number**.

## Building blocks

Built:
- **Light load** (`lightLoad.ts`, `native/ddbackup/`): iPhone backup that keeps only personal data.
- **iOS WhatsApp reader** (`whatsapp.ts`): chats, messages, media from `ChatStorage.sqlite`.
- **Saved WhatsApp backups**: plain folder with the database, media and `backup.json`.
- **Backup decryption** (`backupCrypto.ts`, `backupSource.ts`), binary plist reader (`bplist.ts`).
- **Android detection and backup copy** (`androidWhatsApp.ts`): finds WhatsApp, Business and GBWhatsApp
  and the newest `msgstore.db.cryptNN` on the phone; Back up pulls `Databases`, `Backups` and `Media` as they
  are (still encrypted). Checked against a real phone (Galaxy Z Fold6, crypt14 backup) for detection only.

New:
1. **Binary plist writer + NSKeyedArchiver `MBFile` writer** (inverse of `bplist.ts`), for restore sets.
2. **iOS restore-set builder**: a minimal, unencrypted backup folder holding only one app's domain.
3. **Restore runner**: `ddbackup restore` with app-only options and progress.
4. **Android layer** (adb): push backups and media back (finding and pulling is built).
5. **crypt15 codec**: built (`crypt15.ts`, reading in `androidChats.ts`); checked against our own writer only until a real backup opens.
6. **Converters**: iOS `ChatStorage` ⇄ Android `msgstore` (messages, chats, groups, media references).
7. **Verification**: counts compared before/after every write; abort on mismatch.

## Restore to iPhone (WhatsApp, WhatsApp Business, Kik, Viber)

Flow:
1. User picks a saved backup and a connected iPhone.
2. Checks: Find My is off (`com.apple.fmip` / restore refusal text), the app is installed and signed in,
   enough free space. **Back up the app's current data first** (a saved backup), always.
3. Build a **restore set** in a temp folder:
   - `Manifest.db` with only the app's domain rows (`AppDomainGroup-group.net.whatsapp.WhatsApp.shared` for
     WhatsApp; `…WhatsAppSMB.shared` for Business; `AppDomainGroup-group.com.kik.chat`; `AppDomain-com.viber`),
     each row's `file` blob an `MBFile` keyed archive (Size, Mode, timestamps, UserID/GroupID 501,
     ProtectionClass from the original backup, RelativePath).
   - Files laid out by file id (`<first two hex>/<sha1(domain-path)>`), copied from the saved backup.
   - `Manifest.plist` (unencrypted, Version/SystemDomainsVersion copied from the device's own latest
     backup), `Info.plist`, `Status.plist` (`SnapshotState = finished`).
4. Run `ddbackup -u <udid> -s <udid> restore --system <restore-set-root>` **without** `--remove`, so files not in
   the set stay on the phone. The phone restarts.
5. After restart: light-load again and compare the app's chat and message counts with the saved backup.

Open questions (spike before building):
- ~~Does iOS accept an unencrypted restore set while "Encrypt backups" is on?~~ Answered by the first
  spike: no, iOS refuses a manifest without a keybag (MBErrorDomain 205). Restore sets therefore reuse the
  phone's own keybag and are encrypted like its backups (`restoreSet.ts`, round-trip tested).
- Minimum `Manifest.plist` contents iOS requires for an app-only restore.
- Whether `--system` is needed for app-group containers.

## Android side

Paths (Android 11+ scoped storage; older Android uses `/sdcard/WhatsApp/…`):

| App | Package | Backup and media folder |
|---|---|---|
| WhatsApp | `com.whatsapp` | `/sdcard/Android/media/com.whatsapp/WhatsApp/` (`Databases/msgstore.db.crypt15`, `Media/`) |
| WhatsApp Business | `com.whatsapp.w4b` | `/sdcard/Android/media/com.whatsapp.w4b/WhatsApp Business/` |
| GBWhatsApp | `com.gbwhatsapp` | `/sdcard/Android/media/com.gbwhatsapp/GBWhatsApp/` (older: `/sdcard/GBWhatsApp/`) |

Read: `adb pull` the newest `msgstore.db.crypt15` and `Media/`. Write: `adb push` to the same place, then the
user reinstalls the app, verifies the number and taps Restore, entering the 64-digit key.

Why the 64-digit key: older `crypt12`/`crypt14` files are encrypted with a key that only lives inside the
app's private storage (needs root or an app downgrade, which Mobile Care Plus will not do). The end-to-end backup
key is the user's own, shown once by WhatsApp; with it we can read and write `crypt15` without touching the
app. Mobile Care Plus never stores the key; it is used in memory for one job.

**crypt15 codec**: implement from the published format description: a protobuf header followed by
AES-256-GCM ciphertext; the AES key is derived from the 64-hex-digit root key. Write it ourselves, verified
against a real backup made on a test phone; do not copy GPL code into the app.

## Converters

Core mapping (iOS Core Data tables ⇄ Android tables; names checked against the real databases at build time):

| Concept | iOS (`ChatStorage.sqlite`) | Android (`msgstore.db`) |
|---|---|---|
| Chat | `ZWACHATSESSION` (`ZCONTACTJID`, `ZPARTNERNAME`, `ZSESSIONTYPE`) | `jid` + `chat` |
| Message | `ZWAMESSAGE` (`ZTEXT`, `ZISFROMME`, `ZMESSAGEDATE`, `ZMESSAGETYPE`, `ZSTANZAID`) | `message` (`text_data`, `from_me`, `timestamp`, `message_type`, `key_id`) |
| Media | `ZWAMEDIAITEM` (`ZMEDIALOCALPATH`, `ZTITLE`) | `message_media` (`file_path`, `media_caption`, `mime_type`) |
| Group sender | `ZWAGROUPMEMBER` (`ZMEMBERJID`, `ZCONTACTNAME`) | `sender_jid_row_id` → `jid` |
| Time | seconds since 2001-01-01 | milliseconds since 1970-01-01 |

Rules:
- Use the **target's own database as the template** (its schema version), insert converted rows, keep the
  target's existing chats (merge) unless the user chose "replace".
- Versioned: refuse with a clear message when the database version is one we haven't mapped, rather than
  guessing.
- Media is copied with the target's folder conventions; message rows reference the new paths.

## Safety rules

- Every write is preceded by a saved backup of the target's current data.
- Every write is followed by a count check (chats, messages, media); a mismatch is reported, never hidden.
- Destructive steps (restore, push) need an explicit confirmation naming the phone and the app.
- First real tests on a **spare WhatsApp account/number**, never on the user's main chats.

## Test devices and order

1. iPhone Restore (WhatsApp Business first, on a test account): needs Find My off on the test phone.
2. Android → Android: two Android phones, or one phone reinstalling WhatsApp.
3. iPhone → Android, then Android → iPhone: the iPhone (have) + an Android phone with WhatsApp signed in to
   the **same test number**.
4. GBWhatsApp, then Kik and Viber on iPhone.
