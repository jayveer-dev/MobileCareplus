// The one owner of reading files out of a backup, encrypted or not. Everything else asks this
// module for a file by (domain, relativePath) and never touches the hashed backup layout itself.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { app } from "electron";
import { BACKUP_LOCKED } from "../shared/types";
import { fileDecipher, parseKeybag, unlockKeybag, unwrapFileKey } from "./backupCrypto";
import { backupPath } from "./backups";
import { archivedData, keyedArchiveRoot, parseBinaryPlist, type PlistValue } from "./bplist";
import { run } from "./tools";

/** Private copies live here and are deleted when the app quits; they hold personal data. */
export const workDir = () => join(app.getPath("temp"), `mobilecareplus-${process.pid}`);

interface Unlocked {
  keybagHash: string;
  classKeys: Map<number, Buffer>;
  /** Decrypted Manifest.db, tied to the backup's Manifest.db modification time. */
  manifestPath: string;
  manifestMtime: number;
}

/** Unlocked keys, in memory only; the password itself is never kept. */
const unlocked = new Map<string, Unlocked>();

export async function clearBackupCopies() {
  unlocked.clear();
  await rm(workDir(), { recursive: true, force: true });
}

const backupDir = (sourceId: string) => backupPath(sourceId);
/** Folder-safe form of a source id ("cache:<id>" has a colon, which Windows doesn't allow). */
export const localKey = (sourceId: string) => sourceId.replace(/[^A-Za-z0-9._-]/g, "_");

async function manifestPlist(sourceId: string): Promise<Record<string, PlistValue>> {
  const path = join(backupDir(sourceId), "Manifest.plist");
  let raw = await readFile(path);
  if (raw.toString("latin1", 0, 8) !== "bplist00") {
    // Rare XML Manifest.plist: convert with plistutil to a temp binary copy.
    const tmp = join(workDir(), `${sourceId}-Manifest.bplist`);
    await mkdir(workDir(), { recursive: true });
    await run("plistutil", ["-i", path, "-o", tmp, "-f", "bin"]);
    raw = await readFile(tmp);
  }
  return parseBinaryPlist(raw) as Record<string, PlistValue>;
}

export async function isEncrypted(sourceId: string): Promise<boolean> {
  return (await manifestPlist(sourceId)).IsEncrypted === true;
}

export const isUnlocked = (sourceId: string) => unlocked.has(sourceId);

/** Strips PKCS#7 padding when present; the manifest is padded to the AES block size. */
function unpad(buf: Buffer): Buffer {
  const n = buf[buf.length - 1];
  return n >= 1 && n <= 16 && buf.subarray(buf.length - n).every((b) => b === n) ? buf.subarray(0, buf.length - n) : buf;
}

/**
 * Checks the password and decrypts the file index. Reuses the unlocked keys (and skips the slow
 * password stretch) when the keybag hasn't changed, e.g. after a new incremental backup.
 */
export async function unlockBackup(sourceId: string, password?: string): Promise<void> {
  const manifest = await manifestPlist(sourceId);
  const keybagData = manifest.BackupKeyBag;
  const manifestKey = manifest.ManifestKey;
  if (!Buffer.isBuffer(keybagData) || !Buffer.isBuffer(manifestKey)) throw new Error("This backup is encrypted in an older format Mobile Care Plus can't read (before iOS 10.2).");
  const keybagHash = createHash("sha256").update(keybagData).digest("hex");
  const known = unlocked.get(sourceId);
  let classKeys: Map<number, Buffer>;
  if (known?.keybagHash === keybagHash) classKeys = known.classKeys;
  else if (password !== undefined) classKeys = await unlockKeybag(parseKeybag(keybagData), password);
  else throw new Error(`${BACKUP_LOCKED}Enter the backup password to read this encrypted backup.`);

  const dbPath = join(backupDir(sourceId), "Manifest.db");
  const mtime = (await stat(dbPath)).mtimeMs;
  if (known?.keybagHash === keybagHash && known.manifestMtime === mtime) return;
  const key = unwrapFileKey(classKeys, manifestKey);
  const d = fileDecipher(key);
  const plain = unpad(Buffer.concat([d.update(await readFile(dbPath)), d.final()]));
  if (plain.toString("latin1", 0, 15) !== "SQLite format 3") throw new Error("The backup's file index didn't decrypt correctly. The backup may be damaged; make a new one.");
  const dir = join(workDir(), localKey(sourceId));
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, `Manifest-${mtime}.db`);
  await writeFile(manifestPath, plain);
  unlocked.set(sourceId, { keybagHash, classKeys, manifestPath, manifestMtime: mtime });
}

/** Path to a readable Manifest.db for this backup; throws BACKUP_LOCKED for a locked encrypted one. */
export async function manifestDbPath(sourceId: string): Promise<string> {
  if (!(await isEncrypted(sourceId))) return join(backupDir(sourceId), "Manifest.db");
  await unlockBackup(sourceId);
  return unlocked.get(sourceId)!.manifestPath;
}

export const fileId = (domain: string, relativePath: string) => createHash("sha1").update(`${domain}-${relativePath}`).digest("hex");

/** Writes one backed-up file to dest, decrypting when needed. False when the backup doesn't have it. */
export async function extractFile(sourceId: string, domain: string, relativePath: string, dest: string): Promise<boolean> {
  const id = fileId(domain, relativePath);
  const stored = join(backupDir(sourceId), id.slice(0, 2), id);
  if (!(await stat(stored).catch(() => undefined))) return false;
  const keys = unlocked.get(sourceId);
  if (!(await isEncrypted(sourceId))) {
    await copyFile(stored, dest);
    return true;
  }
  if (!keys) throw new Error(`${BACKUP_LOCKED}Enter the backup password to read this encrypted backup.`);
  const db = new DatabaseSync(keys.manifestPath, { readOnly: true });
  let blob: Uint8Array | undefined;
  try {
    blob = (db.prepare("SELECT file FROM Files WHERE fileID = ?").get(id) as { file?: Uint8Array } | undefined)?.file;
  } finally {
    db.close();
  }
  if (!blob) return false;
  const record = keyedArchiveRoot(parseBinaryPlist(Buffer.from(blob)));
  const wrapped = archivedData(record.EncryptionKey);
  if (!wrapped) {
    // Files iOS stores without a key (empty or unprotected) are kept as-is.
    await copyFile(stored, dest);
    return true;
  }
  await pipeline(createReadStream(stored), fileDecipher(unwrapFileKey(keys.classKeys, wrapped)), createWriteStream(dest));
  // Remove the AES block padding: the record knows the real size.
  if (typeof record.Size === "number") await truncate(dest, record.Size);
  return true;
}
