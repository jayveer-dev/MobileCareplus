import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatBytes, isChatBackup, parseAdbDevices, parseAndroidLongList, parseByteRange, parseContentRows, parseGetprop, parseKeyValues } from "./parse.ts";

test("ideviceinfo key/values skip nested lines", () => {
  const kv = parseKeyValues("DeviceName: Alex's iPhone\nProductVersion: 18.1\nSupportedDeviceFamilies:\n 0: 1\nPhoneNumber: +1 555: 0100\n");
  assert.deepEqual(kv, { DeviceName: "Alex's iPhone", ProductVersion: "18.1", PhoneNumber: "+1 555: 0100" });
});

test("adb devices -l states and model", () => {
  const out = parseAdbDevices(
    "* daemon started successfully\nList of devices attached\nR58M123 device usb:1-1 product:x model:SM_G991B device:o1s\nemulator-5554\tunauthorized\n\n",
  );
  assert.deepEqual(out, [
    { serial: "R58M123", state: "device", model: "SM G991B" },
    { serial: "emulator-5554", state: "unauthorized", model: undefined },
  ]);
});

test("getprop and bytes", () => {
  assert.deepEqual(parseGetprop("[ro.product.model]: [Pixel 8]\r\n[ro.build.version.release]: [15]\n"), {
    "ro.product.model": "Pixel 8",
    "ro.build.version.release": "15",
  });
  assert.equal(formatBytes("128000000000"), "128.0 GB");
  assert.equal(formatBytes(undefined), undefined);
});

test("backup progress and failure lines", async () => {
  const { lastPercent, failureReason, parsePlistScalar } = await import("./parse.ts");
  assert.equal(lastPercent("[==      ] 12% Finished\r[====    ] 45.5% Finished"), 45.5);
  assert.equal(lastPercent("Receiving files"), undefined);
  assert.equal(failureReason("Backup started\nERROR: Device is locked\nbye"), "ERROR: Device is locked");
  assert.equal(failureReason("a\nlast line\n"), "last line");
  assert.equal(parsePlistScalar('<plist version="1.0">\n<string>Alex&apos;s &amp; iPhone</string>\n</plist>'), "Alex's & iPhone");
  assert.equal(parsePlistScalar('<plist version="1.0">\n<true/>\n</plist>'), true);
  assert.equal(parsePlistScalar('<plist version="1.0">\n<dict/>\n</plist>'), undefined);
});

test("backup percent ignores per-file bars", async () => {
  const { backupPercent } = await import("./parse.ts");
  // idevicebackup2 1.4.0
  assert.equal(backupPercent("\r[=====     ] 45% Finished\n\r[==========] 100% (12.0 MB/12.0 MB)     \n"), 45);
  assert.equal(backupPercent("\r[====      ]  20% (1.0 MB/5.0 MB)     "), undefined);
  // later versions: labelled 4-line display
  assert.equal(backupPercent("Backup     [=====     ]  52%\nReceiving  file.db\n           [===]  99.0%   1 MB / 1 MB"), 52);
});

test("transfer bytes, status line and categories", async () => {
  const { transferBytes, statusLine, backupCategory } = await import("./parse.ts");
  assert.deepEqual(transferBytes("\r[===] 20% (1.5 MB/12.0 MB)  \r[====] 40% (4.8 MB/12.0 MB)"), { current: 4.8e6, total: 12e6 });
  assert.equal(statusLine("Incremental backup mode.\nReceiving files\n\r[==] 3% (1 MB/2 MB)"), "Receiving files");
  assert.equal(backupCategory("CameraRollDomain", "Media/DCIM/100APPLE/IMG_0001.HEIC"), "Photos & videos");
  assert.equal(backupCategory("MediaDomain", "Library/SMS/Attachments/22/02/x.jpg"), "Message attachments");
  assert.equal(backupCategory("HomeDomain", "Library/SMS/sms.db"), "Messages");
  assert.equal(backupCategory("AppDomainGroup-group.com.google.common", "Library/x"), "App data");
  assert.equal(backupCategory("WirelessDomain", "Library/x"), "Settings & system");
});

test("storage parsers", async () => {
  const { parseDfKilobytes } = await import("./parse.ts");
  assert.deepEqual(parseDfKilobytes("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/dm-48 2 1 1 50% /data\n"), { total: 2048, used: 1024, free: 1024 });
  assert.equal(parseDfKilobytes("garbage"), undefined);
});

test("afc long listing", async () => {
  const { parseAfcLongList } = await import("./parse.ts");
  assert.deepEqual(
    parseAfcLongList(
      "-rw-r--r--    1 mobile mobile    2439012 04 Oct 2026 09:32:40 IMG_0012.HEIC\ndrwxr-xr-x    5 mobile mobile        160 30 Sep 2026 08:01:17 100APPLE\nnoise\n",
    ),
    [
      { isDir: false, size: 2439012, date: "2026-10-04T09:32:40", name: "IMG_0012.HEIC" },
      { isDir: true, size: 160, date: "2026-09-30T08:01:17", name: "100APPLE" },
    ],
  );
});

test("backup errors in plain language", async () => {
  const { explainBackupOutput, BACKUP_SERVICE_BUSY } = await import("./parse.ts");
  const busy = 'Started "com.apple.mobilebackup2" service on port 62670.\nCould not perform backup protocol version exchange, error code -1';
  assert.ok(BACKUP_SERVICE_BUSY.test(busy));
  assert.match(explainBackupOutput(busy) ?? "", /backup service didn't respond/);
  assert.match(explainBackupOutput("No device found with udid X.") ?? "", /disconnected/);
  assert.match(explainBackupOutput("ERROR: Backup encryption is not enabled. Aborting.") ?? "", /already off/);
  assert.equal(explainBackupOutput("Backup Successful."), undefined);
});

test("model names and battery health", async () => {
  const { modelName, batteryHealth } = await import("./parse.ts");
  assert.equal(modelName("iPhone19,7"), "iPhone 18 Pro Max");
  assert.equal(modelName("iPhone99,1"), "iPhone99,1");
  assert.deepEqual(batteryHealth({ CycleCount: 11, IsCharging: true, BatteryData: { DesignCapacity: 5335, NominalChargeCapacity: 5453 } }), { health: 100, cycles: 11, charging: true });
  assert.deepEqual(batteryHealth({ DesignCapacity: 3000, AppleRawMaxCapacity: 2550, CycleCount: 500 }), { health: 85, cycles: 500, charging: undefined });
  assert.equal(batteryHealth({}).health, undefined);
});

test("passcode prompt during backup", async () => {
  const { statusLine, explainBackupOutput } = await import("./parse.ts");
  assert.equal(statusLine("Full backup mode.\n*** Waiting for passcode to be entered on the device ***\n"), "Enter your passcode on the iPhone to allow this");
  assert.match(explainBackupOutput("*** Waiting for passcode to be entered on the device ***\nERROR: Could not receive from mobilebackup2 (-256)\nBackup Aborted.") ?? "", /passcode/);
});

test("byte ranges for video seeking", () => {
  assert.equal(parseByteRange(null, 100), undefined);
  assert.equal(parseByteRange("items=0-1", 100), undefined);
  assert.deepEqual(parseByteRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange("bytes=90-500", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-30", 100), { start: 70, end: 99 });
  assert.equal(parseByteRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseByteRange("bytes=20-10", 100), "unsatisfiable");
});

test("Android ls -l: files, folders, names with spaces, noise skipped", () => {
  const out = parseAndroidLongList(`total 12
-rw-rw---- 1 u0_a123 media_rw 5242880 2026-10-20 02:00 msgstore.db.crypt15
-rw-rw---- 1 u0_a123 media_rw 5100000 2026-10-19 02:00 msgstore-2026-10-19.1.db.crypt15
drwxrws--- 2 u0_a123 media_rw 3452 2026-10-01 10:11 WhatsApp Images
ls: /sdcard/x: No such file or directory`);
  assert.deepEqual(out, [
    { isDir: false, size: 5242880, date: "2026-10-20T02:00:00", name: "msgstore.db.crypt15" },
    { isDir: false, size: 5100000, date: "2026-10-19T02:00:00", name: "msgstore-2026-10-19.1.db.crypt15" },
    { isDir: true, size: 3452, date: "2026-10-01T10:11:00", name: "WhatsApp Images" },
  ]);
});

test("content query rows: commas inside values, NULL, noise", () => {
  const cols = ["_id", "_data", "datetaken", "bucket_display_name"];
  const rows = parseContentRows(
    `Row: 0 _id=12, _data=/storage/emulated/0/DCIM/Camera/a, b.jpg, datetaken=1729740000000, bucket_display_name=Camera
Row: 1 _id=13, _data=/storage/emulated/0/Pictures/x.png, datetaken=NULL, bucket_display_name=NULL
No result found.`,
    cols,
  );
  assert.deepEqual(rows, [
    { _id: "12", _data: "/storage/emulated/0/DCIM/Camera/a, b.jpg", datetaken: "1729740000000", bucket_display_name: "Camera" },
    { _id: "13", _data: "/storage/emulated/0/Pictures/x.png", datetaken: undefined, bucket_display_name: undefined },
  ]);
});

test("WhatsApp chat backups on Android: full ones only, not increments or other databases", () => {
  assert.ok(isChatBackup("msgstore.db.crypt15"));
  assert.ok(isChatBackup("msgstore-2026-10-23.1.db.crypt14"));
  assert.ok(!isChatBackup("msgstore-increment-1-2026-10-23.1.db.crypt14"));
  assert.ok(!isChatBackup("wa.db.crypt15"));
});
