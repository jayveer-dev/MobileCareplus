// iOS restore sets: a minimal, unencrypted backup folder holding only the files to put on the
// phone, which iOS restores itself (ddbackup restore). This is the one way Apple lets data in,
// and the engine behind moving contacts, calendars and photos INTO an iPhone.
// Field values mirror a real backup's (MBFile keyed archives; Status/Manifest plists); pure code,
// so `node --test` covers it. Running a restore lives elsewhere and always backs up first.
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { aesUnwrap, aesWrap } from "./backupCrypto.ts";
import { keyedArchive, type PlistValue, writeBinaryPlist } from "./bplist.ts"; // .ts so node --test can load this module directly
import { DatabaseSync } from "node:sqlite";

export const restoreFileId = (domain: string, relativePath: string) => createHash("sha1").update(`${domain}-${relativePath}`).digest("hex");

export interface RestoreEntry {
  domain: string;
  relativePath: string;
  data: Buffer;
  /** iOS data-protection class of the original file (3 = until first unlock); keep the source's. */
  protectionClass?: number;
}

/**
 * Keys for an encrypted restore set, taken from the phone's own encrypted backup after unlocking:
 * its keybag and wrapped manifest key are reused as they are, so the phone can unwrap them with
 * the same backup password. Each payload file gets a fresh key wrapped with the class key.
 */
export interface RestoreEncryption {
  backupKeyBag: Buffer;
  /** 4-byte protection class + RFC 3394-wrapped manifest key, exactly as Manifest.plist holds it. */
  manifestKey: Buffer;
  classKeys: Map<number, Buffer>;
}

/** AES-256-CBC with a zero IV and PKCS#7 padding: the backup format's file encryption. */
function encrypt(key: Buffer, plain: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-cbc", key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

const wrapKey = (classKeys: Map<number, Buffer>, protectionClass: number, key: Buffer): Buffer => {
  const classKey = classKeys.get(protectionClass);
  if (!classKey) throw new Error(`The backup password didn't unlock protection class ${protectionClass}.`);
  return Buffer.concat([Buffer.from(new Uint32Array([protectionClass]).buffer), aesWrap(classKey, key)]);
};

/** Values copied from the phone's own latest backup, so versions match what iOS expects. */
export interface RestoreTemplate {
  /** Manifest.plist Version, e.g. "10.0". */
  version: string;
  /** Manifest.plist SystemDomainsVersion, e.g. "24.0". */
  systemDomainsVersion: string;
  /** Manifest.plist Lockdown dictionary (device identity). */
  lockdown: Record<string, PlistValue>;
}

const FILE_MODE = 0o100644; // regular file rw-r--r--, as real backups record
const DIR_MODE = 0o040755;
const MOBILE_UID = 501;

function mbFile(relativePath: string, inode: number, file?: { size: number; protectionClass: number; encryptionKey?: Buffer }): Buffer {
  const now = Math.floor(Date.now() / 1000);
  return keyedArchive("MBFile", {
    RelativePath: relativePath,
    Flags: 0,
    Mode: file ? FILE_MODE : DIR_MODE,
    ...(file?.encryptionKey ? { EncryptionKey: file.encryptionKey } : {}),
    Size: file?.size ?? 0,
    InodeNumber: inode,
    UserID: MOBILE_UID,
    GroupID: MOBILE_UID,
    Birth: now,
    LastModified: now,
    LastStatusChange: now,
    ProtectionClass: file?.protectionClass ?? 0,
  });
}

/**
 * Writes a restore set under dir: Manifest.db with the entries and their parent folders,
 * the three plists, and each file stored by its id. Returns the folder ddbackup restores from.
 */
export async function buildRestoreSet(dir: string, udid: string, template: RestoreTemplate, entries: RestoreEntry[], encryption?: RestoreEncryption): Promise<string> {
  if (entries.length === 0) throw new Error("Nothing to restore.");
  const root = join(dir, udid);
  await mkdir(root, { recursive: true });

  const db = new DatabaseSync(join(root, "Manifest.db"));
  let inode = 1;
  try {
    db.exec("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)");
    db.exec("CREATE TABLE Properties (key TEXT PRIMARY KEY, value BLOB)");
    const insert = db.prepare("INSERT OR IGNORE INTO Files (fileID, domain, relativePath, flags, file) VALUES (?, ?, ?, ?, ?)");

    // Parent folders first (flags 2), nearest root first, once per domain+path.
    const seen = new Set<string>();
    for (const e of entries) {
      const parts = e.relativePath.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join("/");
        const key = `${e.domain}\n${path}`;
        if (path === "" || seen.has(key)) continue;
        seen.add(key);
        insert.run(restoreFileId(e.domain, path), e.domain, path, 2, mbFile(path, inode++));
      }
    }
    for (const e of entries) {
      const id = restoreFileId(e.domain, e.relativePath);
      const protectionClass = e.protectionClass ?? 3;
      let stored = e.data;
      let encryptionKey: Buffer | undefined;
      if (encryption) {
        const fileKey = randomBytes(32);
        stored = encrypt(fileKey, e.data);
        encryptionKey = wrapKey(encryption.classKeys, protectionClass, fileKey);
      }
      insert.run(id, e.domain, e.relativePath, 1, mbFile(e.relativePath, inode++, { size: e.data.length, protectionClass, encryptionKey }));
      await mkdir(join(root, id.slice(0, 2)), { recursive: true });
      await writeFile(join(root, id.slice(0, 2), id), stored);
    }
  } finally {
    db.close();
  }

  // iOS refuses a manifest without a keybag (spike result: MBErrorDomain 205), so restore sets
  // reuse the phone's own keybag and are encrypted like its backups; it unwraps them with the
  // same backup password at restore time.
  if (encryption) {
    const manifestDbKey = unwrapManifestKey(encryption);
    const raw = await readFile(join(root, "Manifest.db"));
    await writeFile(join(root, "Manifest.db"), encrypt(manifestDbKey, raw));
  }
  await writeFile(
    join(root, "Manifest.plist"),
    writeBinaryPlist({
      Version: template.version,
      SystemDomainsVersion: template.systemDomainsVersion,
      Date: new Date(),
      IsEncrypted: !!encryption,
      WasPasscodeSet: !!encryption,
      ...(encryption ? { BackupKeyBag: encryption.backupKeyBag, ManifestKey: encryption.manifestKey } : {}),
      Lockdown: template.lockdown,
      Applications: {},
    }),
  );
  await writeFile(
    join(root, "Status.plist"),
    writeBinaryPlist({ UUID: randomUUID().toUpperCase(), Date: new Date(), IsFullBackup: false, Version: "3.3", BackupState: "new", SnapshotState: "finished" }),
  );
  await writeFile(join(root, "Info.plist"), writeBinaryPlist({ "Target Identifier": udid, "Unique Identifier": udid.toUpperCase() }));
  return dir;
}

function unwrapManifestKey(encryption: RestoreEncryption): Buffer {
  const classKey = encryption.classKeys.get(encryption.manifestKey.readUInt32LE(0));
  const key = classKey && aesUnwrap(classKey, encryption.manifestKey.subarray(4));
  if (!key) throw new Error("The manifest key didn't unwrap with these class keys.");
  return key;
}
