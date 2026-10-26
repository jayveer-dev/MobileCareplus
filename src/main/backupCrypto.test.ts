import { strict as assert } from "node:assert";
import { createCipheriv } from "node:crypto";
import { test } from "node:test";
import { aesUnwrap, aesWrap, fileDecipher, parseKeybag, unlockKeybag, unwrapFileKey, WrongPasswordError } from "./backupCrypto.ts";
import { archivedData, keyedArchiveRoot, parseBinaryPlist } from "./bplist.ts";

const hex = (s: string) => Buffer.from(s.replace(/\s/g, ""), "hex");

test("AES key wrap matches RFC 3394 §4.6 (256-bit KEK, 256-bit key)", () => {
  const kek = hex("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F");
  const key = hex("00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F");
  const wrapped = hex("28C9F404C4B810F4CBCCB35CFB87F8263F5786E2D80ED326CBC7F0E71A99F43BFB988B9B7A02DD21");
  assert.deepEqual(aesWrap(kek, key), wrapped);
  assert.deepEqual(aesUnwrap(kek, wrapped), key);
  assert.equal(aesUnwrap(Buffer.alloc(32, 7), wrapped), undefined, "wrong KEK fails the integrity check");
});

const tlv = (tag: string, value: Buffer) => {
  const head = Buffer.alloc(8);
  head.write(tag, 0, "latin1");
  head.writeUInt32BE(value.length, 4);
  return Buffer.concat([head, value]);
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

test("keybag unlock, file key unwrap and file decryption end to end", async () => {
  // Build a keybag the way iOS does, with small iteration counts so the test is fast.
  const password = "correct horse";
  const salt = Buffer.alloc(20, 1);
  const dpsl = Buffer.alloc(20, 2);
  const { pbkdf2Sync } = await import("node:crypto");
  const kek = pbkdf2Sync(pbkdf2Sync(password, dpsl, 10, 32, "sha256"), salt, 5, 32, "sha1");
  const classKey3 = Buffer.alloc(32, 3);
  const keybag = Buffer.concat([
    tlv("VERS", u32(3)),
    tlv("TYPE", u32(1)),
    tlv("UUID", Buffer.alloc(16, 9)),
    tlv("WRAP", u32(0)),
    tlv("SALT", salt),
    tlv("ITER", u32(5)),
    tlv("DPWT", u32(1)),
    tlv("DPIC", u32(10)),
    tlv("DPSL", dpsl),
    tlv("UUID", Buffer.alloc(16, 8)),
    tlv("CLAS", u32(3)),
    tlv("WRAP", u32(2)),
    tlv("KTYP", u32(0)),
    tlv("WPKY", aesWrap(kek, classKey3)),
  ]);
  const parsed = parseKeybag(keybag);
  assert.equal(parsed.iterations, 5);
  assert.equal(parsed.dpic, 10);
  assert.deepEqual(parsed.classKeys.map((k) => k.protectionClass), [3]);

  await assert.rejects(unlockKeybag(parsed, "wrong"), WrongPasswordError);
  const classKeys = await unlockKeybag(parsed, password);
  assert.deepEqual(classKeys.get(3), classKey3);

  // A file key wrapped with class 3, prefixed with its class (little-endian), as in MBFile.EncryptionKey.
  const fileKey = Buffer.alloc(32, 5);
  const persistent = Buffer.concat([Buffer.from([3, 0, 0, 0]), aesWrap(classKey3, fileKey)]);
  assert.deepEqual(unwrapFileKey(classKeys, persistent), fileKey);
  assert.throws(() => unwrapFileKey(classKeys, Buffer.concat([Buffer.from([4, 0, 0, 0]), aesWrap(classKey3, fileKey)])), /protection class 4/);

  const plain = Buffer.from("hello encrypted backup");
  const padded = Buffer.concat([plain, Buffer.alloc(16 - (plain.length % 16), 16 - (plain.length % 16))]);
  const enc = createCipheriv("aes-256-cbc", fileKey, Buffer.alloc(16));
  enc.setAutoPadding(false);
  const cipher = Buffer.concat([enc.update(padded), enc.final()]);
  const d = fileDecipher(fileKey);
  assert.equal(Buffer.concat([d.update(cipher), d.final()]).subarray(0, plain.length).toString(), plain.toString());
});

test("binary plist and keyed archive", () => {
  // Made with Python's plistlib (FMT_BINARY): an MBFile-like NSKeyedArchiver record.
  const fixture = Buffer.from(
    "YnBsaXN0MDDUAQIDBAUGHSBZJGFyY2hpdmVyWCRvYmplY3RzVCR0b3BYJHZlcnNpb25fEA9OU0tleWVkQXJjaGl2ZXKkBwgZHFUkbnVsbNgJCgsMDQ4PEBESExQVFhcYU0JpZ11FbmNyeXB0aW9uS2V5VE5hbWVTTmVnUlBpXxAPUHJvdGVjdGlvbkNsYXNzXFJlbGF0aXZlUGF0aFRTaXplEwAAAQAAAAAAgAJlAEoAYQB5IBkAcxP/////////+yNADAAAAAAAABADgAMRMDnRGhtXTlMuZGF0YUcDAAAAAQIDXxASTGlicmFyeS9TTVMvc21zLmRi0R4fVHJvb3SAARIAAYagAAgAEQAbACQAKQAyAEQASQBPAGAAZAByAHcAewB+AJAAnQCiAKsArQC4AMEAygDMAM4A0QDUANwA5AD5APwBAQEDAAAAAAAAAgEAAAAAAAAAIQAAAAAAAAAAAAAAAAAAAQg=",
    "base64",
  );
  const root = keyedArchiveRoot(parseBinaryPlist(fixture));
  assert.equal(root.Size, 12345);
  assert.equal(root.ProtectionClass, 3);
  assert.equal(root.Big, 2 ** 40);
  assert.equal(root.Neg, -5);
  assert.equal(root.Pi, 3.5);
  assert.equal(root.Name, "Jay’s");
  assert.equal(root.RelativePath, "Library/SMS/sms.db");
  assert.deepEqual(archivedData(root.EncryptionKey), Buffer.from([3, 0, 0, 0, 1, 2, 3]));
  assert.throws(() => parseBinaryPlist(Buffer.from("not a plist at all, really not one at all")), /Not a binary plist/);
});

test("binary plist writer round-trips and macOS plutil accepts it", async () => {
  const { writeBinaryPlist, parseBinaryPlist, keyedArchive, keyedArchiveRoot, Uid } = await import("./bplist.ts");
  const value = {
    ascii: "Library/SMS/sms.db",
    unicode: "Jay’s iPhone 👋",
    small: 7,
    big: 2 ** 40,
    neg: -5,
    pi: 3.25,
    yes: true,
    no: false,
    when: new Date("2026-10-24T10:00:00.000Z"),
    data: Buffer.from([0, 1, 2, 255]),
    list: [1, "two", [3]],
    uid: new Uid(300),
    many: Array.from({ length: 300 }, (_, i) => i),
  };
  const bytes = writeBinaryPlist(value);
  const back = parseBinaryPlist(bytes) as Record<string, unknown>;
  assert.equal(back.ascii, value.ascii);
  assert.equal(back.unicode, value.unicode);
  assert.equal(back.big, value.big);
  assert.equal(back.neg, -5);
  assert.equal(back.pi, 3.25);
  assert.equal(back.yes, true);
  assert.equal((back.when as Date).toISOString(), value.when.toISOString());
  assert.deepEqual(back.data, value.data);
  assert.deepEqual(back.list, [1, "two", [3]]);
  assert.equal((back.uid as InstanceType<typeof Uid>).value, 300);
  assert.equal((back.many as number[])[299], 299);

  const record = keyedArchive("MBFile", { RelativePath: "ChatStorage.sqlite", Size: 1234, ProtectionClass: 3, EncryptionKey: Buffer.from([3, 0, 0, 0, 9]) });
  const root = keyedArchiveRoot(parseBinaryPlist(record));
  assert.equal(root.RelativePath, "ChatStorage.sqlite");
  assert.equal(root.Size, 1234);
  assert.deepEqual(root.EncryptionKey, Buffer.from([3, 0, 0, 0, 9]));

  // Apple's own validator, where available (macOS).
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  if (process.platform === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "bplist-"));
    writeFileSync(join(dir, "a.plist"), bytes);
    writeFileSync(join(dir, "b.plist"), record);
    assert.match(execFileSync("plutil", ["-lint", join(dir, "a.plist"), join(dir, "b.plist")]).toString(), /OK[\s\S]*OK/);
  }
});
