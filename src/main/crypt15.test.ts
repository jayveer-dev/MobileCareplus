import { strict as assert } from "node:assert";
import { createCipheriv } from "node:crypto";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { cipherKey, decryptCrypt15, encryptCrypt15, parseBackupKey, WrongKeyError } from "./crypt15.ts";

// ponytail: these check the decoder against our own writer and the layout variants; the format's
// match with WhatsApp's real files is checked by opening a real backup (docs/TRANSFER-DESIGN.md).
const KEY = parseBackupKey("0123 4567 89ab cdef 0123 4567 89AB CDEF 0123-4567-89ab-cdef-0123-4567-89ab-cdef");
const DB = Buffer.from("SQLite format 3\0 pretend database contents ".repeat(50));

test("64-digit key: spacing and case ignored, anything else refused", () => {
  assert.equal(KEY.length, 32);
  assert.equal(KEY.toString("hex"), "0123456789abcdef".repeat(4));
  assert.throws(() => parseBackupKey("1234"), /64 characters/);
  assert.throws(() => parseBackupKey("g".repeat(64)), /64 characters/);
});

test("round trip, and a wrong key is reported as such", () => {
  const file = encryptCrypt15(DB, KEY);
  assert.deepEqual(decryptCrypt15(file, KEY), DB);
  assert.throws(() => decryptCrypt15(file, parseBackupKey("f".repeat(64))), WrongKeyError);
});

test("layout without the feature flag and without the MD5 trailer", () => {
  const iv = Buffer.alloc(16, 7);
  const prefix = Buffer.concat([Buffer.from([0x08, 0x01, 0x1a, 0x12, 0x0a, 0x10]), iv]);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(KEY), iv);
  const body = Buffer.concat([cipher.update(deflateSync(DB)), cipher.final(), cipher.getAuthTag()]);
  assert.deepEqual(decryptCrypt15(Buffer.concat([Buffer.from([prefix.length]), prefix, body]), KEY), DB);
});

test("older backups without an IV field are refused with the reason", () => {
  const prefix = Buffer.from([0x08, 0x01, 0x12, 0x02, 0x0a, 0x00]); // field 2 (crypt14 info), no field 3
  assert.throws(() => decryptCrypt15(Buffer.concat([Buffer.from([prefix.length]), prefix, Buffer.alloc(64)]), KEY), /isn't end-to-end encrypted/);
});
