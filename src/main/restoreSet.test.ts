import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { keyedArchiveRoot, parseBinaryPlist } from "./bplist.ts";
import { buildRestoreSet, restoreFileId } from "./restoreSet.ts";

const TEMPLATE = { version: "10.0", systemDomainsVersion: "24.0", lockdown: { ProductVersion: "27.0.1", UniqueDeviceID: "TEST-UDID" } };

test("restore set: manifest rows, parent folders, plists and stored files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rset-"));
  const data = Buffer.from("SQLite format 3\0fake");
  await buildRestoreSet(dir, "TEST-UDID", TEMPLATE, [
    { domain: "HomeDomain", relativePath: "Library/AddressBook/AddressBook.sqlitedb", data, protectionClass: 3 },
    { domain: "HomeDomain", relativePath: "Library/AddressBook/AddressBookImages.sqlitedb", data },
  ]);
  const root = join(dir, "TEST-UDID");

  const db = new DatabaseSync(join(root, "Manifest.db"), { readOnly: true });
  const rows = db.prepare("SELECT fileID, domain, relativePath, flags, file FROM Files ORDER BY relativePath").all() as Record<string, string | number | Uint8Array>[];
  db.close();
  // Two folders (Library, Library/AddressBook) + two files.
  assert.deepEqual(rows.map((r) => [r.relativePath, r.flags]), [
    ["Library", 2],
    ["Library/AddressBook", 2],
    ["Library/AddressBook/AddressBook.sqlitedb", 1],
    ["Library/AddressBook/AddressBookImages.sqlitedb", 1],
  ]);
  const file = keyedArchiveRoot(parseBinaryPlist(Buffer.from(rows[2].file as Uint8Array)));
  assert.equal(file.RelativePath, "Library/AddressBook/AddressBook.sqlitedb");
  assert.equal(file.Size, data.length);
  assert.equal(file.Mode, 0o100644);
  assert.equal(file.ProtectionClass, 3);
  assert.equal(file.UserID, 501);
  const folder = keyedArchiveRoot(parseBinaryPlist(Buffer.from(rows[0].file as Uint8Array)));
  assert.equal(folder.Mode, 0o040755);

  // The file lands at <first two hex>/<sha1(domain-path)>.
  const id = String(rows[2].fileID);
  assert.equal(id, restoreFileId("HomeDomain", "Library/AddressBook/AddressBook.sqlitedb"));
  assert.deepEqual(readFileSync(join(root, id.slice(0, 2), id)), data);

  // All three plists are well-formed (plutil parses them) and unencrypted.
  for (const name of ["Manifest.plist", "Status.plist", "Info.plist"]) execFileSync("plutil", ["-lint", join(root, name)]);
  const manifest = parseBinaryPlist(readFileSync(join(root, "Manifest.plist"))) as Record<string, unknown>;
  assert.equal(manifest.IsEncrypted, false);
  assert.equal(manifest.Version, "10.0");
  assert.deepEqual((manifest.Lockdown as Record<string, unknown>).ProductVersion, "27.0.1");
  const status = parseBinaryPlist(readFileSync(join(root, "Status.plist"))) as Record<string, unknown>;
  assert.equal(status.SnapshotState, "finished");
});

test("restore set refuses to build empty", async () => {
  await assert.rejects(buildRestoreSet(mkdtempSync(join(tmpdir(), "rset-")), "x", TEMPLATE, []), /Nothing to restore/);
});

test("encrypted restore set round-trips with the backup reader's own crypto", async () => {
  const { randomBytes } = await import("node:crypto");
  const { aesWrap, fileDecipher, unwrapFileKey } = await import("./backupCrypto.ts");
  const classKey = randomBytes(32);
  const manifestKeyPlain = randomBytes(32);
  const classKeys = new Map([[3, classKey]]);
  const manifestKey = Buffer.concat([Buffer.from([3, 0, 0, 0]), aesWrap(classKey, manifestKeyPlain)]);
  const encryption = { backupKeyBag: Buffer.from("KEYBAG"), manifestKey, classKeys };

  const dir = mkdtempSync(join(tmpdir(), "rset-enc-"));
  const data = Buffer.from("hello, this is a contacts database stand-in");
  await buildRestoreSet(dir, "UDID-ENC", TEMPLATE, [{ domain: "HomeDomain", relativePath: "Library/AddressBook/AddressBook.sqlitedb", data, protectionClass: 3 }], encryption);
  const root = join(dir, "UDID-ENC");

  // Manifest.plist carries the keybag and says encrypted.
  const manifest = parseBinaryPlist(readFileSync(join(root, "Manifest.plist"))) as Record<string, unknown>;
  assert.equal(manifest.IsEncrypted, true);
  assert.deepEqual(manifest.BackupKeyBag, Buffer.from("KEYBAG"));
  assert.deepEqual(manifest.ManifestKey, manifestKey);

  // Manifest.db decrypts with the manifest key back to SQLite.
  const decipherDb = fileDecipher(manifestKeyPlain);
  const db = Buffer.concat([decipherDb.update(readFileSync(join(root, "Manifest.db"))), decipherDb.final()]);
  assert.equal(db.toString("latin1", 0, 15), "SQLite format 3");

  // The stored file decrypts with its wrapped key, exactly as the backup reader would.
  const tmp = mkdtempSync(join(tmpdir(), "rset-db-"));
  const plainDb = join(tmp, "m.db");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(plainDb, db.subarray(0, db.length - db[db.length - 1])); // unpad
  const mdb = new DatabaseSync(plainDb, { readOnly: true });
  const row = mdb.prepare("SELECT fileID, file FROM Files WHERE flags = 1").get() as { fileID: string; file: Uint8Array };
  mdb.close();
  const record = keyedArchiveRoot(parseBinaryPlist(Buffer.from(row.file)));
  const fileKey = unwrapFileKey(classKeys, record.EncryptionKey as Buffer);
  const d = fileDecipher(fileKey);
  const stored = readFileSync(join(root, row.fileID.slice(0, 2), row.fileID));
  const plain = Buffer.concat([d.update(stored), d.final()]).subarray(0, record.Size as number);
  assert.deepEqual(plain, data);
});
