import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { app, BrowserWindow, dialog, shell } from "electron";
import type { Backup, BackupCategory, BackupContents, RestoreOptions } from "../shared/types";
import { BACKUP_SERVICE_BUSY, backupCategory, backupPercent, explainBackupOutput, parsePlistScalar, statusLine, transferBytes } from "./parse";
import { isEncrypted, isUnlocked, manifestDbPath } from "./backupSource";
import { startTask } from "./tasks";
import { run, ToolError } from "./tools";

/** idevicebackup2 writes <root>/<source UDID>/. */
export const backupRoot = () => join(app.getPath("userData"), "Backups");

/** Exit code 0 can still carry "Backup Failed (Error Code …)" or "ERROR: …" lines. */
export const reportedFailure = (output: string) => {
  const line = output
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .find((l) => /^ERROR\b/.test(l) || /\bFailed\b/.test(l) || /^Could not /.test(l));
  return line && (explainBackupOutput(output) ?? line);
};

async function plistValue(file: string, key: string) {
  try {
    return parsePlistScalar(await run("plistutil", ["-i", file, "-n", key, "-f", "xml"]));
  } catch {
    return undefined;
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    // A backup in progress moves files while we count; a file that vanished counts as 0.
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name)).catch(() => undefined))?.size ?? 0;
  }
  return total;
}

/**
 * Personal-data cache: a backup folder that keeps only the files Mobile Care Plus reads (messages,
 * contacts, chat apps…), shared by the main app and Mobile Care Plus Transfer. Its sources are
 * named "cache:<device id>" so every backup reader works on it unchanged.
 */
export const CACHE_PREFIX = "cache:";
/** Where the app keeps its own data: the userData folder ("Mobile Care Plus" when installed, set at startup). */
export const storageRoot = () => app.getPath("userData");
export const cacheRoot = () => join(storageRoot(), "DataCache");

/** The one place that turns a source id into its folder: a real backup or the personal-data cache. */
export const backupPath = (sourceId: string) =>
  sourceId.startsWith(CACHE_PREFIX) ? join(cacheRoot(), sourceId.slice(CACHE_PREFIX.length)) : join(backupRoot(), sourceId);

/** Facts about one backup folder, or undefined when it isn't a finished backup. */
export async function describeBackup(sourceId: string, measureSize = true): Promise<Backup | undefined> {
  const path = backupPath(sourceId);
  const info = join(path, "Info.plist");
  // A folder without Info.plist is an interrupted first backup; nothing to restore from it.
  if (!(await stat(info).catch(() => undefined))?.isFile()) return undefined;
  const [deviceName, productType, iosVersion, date, encrypted] = await Promise.all([
    plistValue(info, "Device Name"),
    plistValue(info, "Product Type"),
    plistValue(info, "Product Version"),
    plistValue(info, "Last Backup Date"),
    plistValue(join(path, "Manifest.plist"), "IsEncrypted"),
  ]);
  return {
    sourceId,
    deviceName: typeof deviceName === "string" ? deviceName : "iPhone",
    productType: typeof productType === "string" ? productType : undefined,
    iosVersion: typeof iosVersion === "string" ? iosVersion : undefined,
    date: typeof date === "string" ? date : undefined,
    encrypted: encrypted === true,
    sizeBytes: measureSize ? await dirSize(path) : 0,
    path,
  };
}

export async function listBackups(): Promise<Backup[]> {
  let names: string[];
  try {
    names = await readdir(backupRoot());
  } catch {
    return [];
  }
  const backups = await Promise.all(names.map((sourceId) => describeBackup(sourceId)));
  return backups.filter((b): b is Backup => b !== undefined).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

const formatSize = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(0)} MB`);

/**
 * idevicebackup2 reports transfers in parts, each counting from 0 to its own total.
 * Adds finished parts up so the user sees one growing "received so far" figure.
 */
export function transferDescriber() {
  let done = 0;
  let last: { current: number; total: number } | undefined;
  let step: string | undefined;
  return (chunk: string) => {
    step = statusLine(chunk)?.replace(/\.$/, "") ?? step;
    const t = transferBytes(chunk);
    if (!t) return step;
    if (last && t.current < last.current) done += last.total;
    last = t;
    return `${step ?? "Transferring"} · ${formatSize(done + t.current)} so far`;
  };
}

/** Backs up; the first time copies everything, after that only what changed (iOS decides). */
export async function startBackup(deviceId: string) {
  await mkdir(backupRoot(), { recursive: true });
  startTask({
    deviceId,
    title: "Backup",
    tool: "idevicebackup2",
    args: ["-u", deviceId, "backup", backupRoot()],
    checkOutput: reportedFailure,
    explain: explainBackupOutput,
    progress: backupPercent,
    describe: transferDescriber(),
  });
}

export async function restoreBackup(deviceId: string, { sourceId, password }: RestoreOptions, win?: BrowserWindow) {
  const backup = (await listBackups()).find((b) => b.sourceId === sourceId);
  if (!backup) throw new Error("Backup not found.");
  const options = {
    type: "warning" as const,
    buttons: ["Restore", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Restore "${backup.deviceName}" backup to this iPhone?`,
    detail:
      "Everything on the iPhone is replaced with the backup and the iPhone restarts. Turn off Find My on the iPhone first, and keep it connected until it finishes.",
  };
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (response !== 0) return false;
  startTask({
    deviceId,
    title: `Restore from ${backup.deviceName}`,
    tool: "idevicebackup2",
    args: ["-u", deviceId, "-s", sourceId, "restore", "--system", "--settings", backupRoot()],
    env: password ? { BACKUP_PASSWORD: password } : undefined,
    checkOutput: reportedFailure,
    explain: explainBackupOutput,
    progress: backupPercent,
    describe: transferDescriber(),
  });
  return true;
}

export async function backupEncryption(deviceId: string): Promise<boolean> {
  const out = await run("ideviceinfo", ["-u", deviceId, "-q", "com.apple.mobile.backup", "-k", "WillEncrypt"]);
  return out.trim() === "true";
}

/** The device itself holds the password; turning encryption off needs the current one. */
const BUSY_RETRIES = 4;
const BUSY_WAIT_MS = 5000;

/**
 * Runs a short idevicebackup2 command, retrying while the iPhone's backup service is still busy
 * (it stays busy for a while after a cancelled backup). Errors come back in plain language.
 */
async function runBackupCommand(args: string[], env?: Record<string, string>): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    let out: string;
    try {
      out = await run("idevicebackup2", args, { env, timeoutMs: 120_000 });
    } catch (e) {
      out = e instanceof ToolError ? e.output : String(e);
    }
    const failure = reportedFailure(out);
    if (!failure) return out;
    if (BACKUP_SERVICE_BUSY.test(out) && attempt < BUSY_RETRIES) {
      await new Promise((r) => setTimeout(r, BUSY_WAIT_MS));
      continue;
    }
    throw new Error(failure);
  }
}

/** The device itself holds the password; turning encryption off needs the current one. */
export async function setBackupEncryption(deviceId: string, on: boolean, password: string) {
  await runBackupCommand(["-u", deviceId, "encryption", on ? "on" : "off"], { BACKUP_PASSWORD: password });
}

export async function removeBackup(sourceId: string, win?: BrowserWindow) {
  const path = join(backupRoot(), sourceId);
  const options = {
    type: "warning" as const,
    buttons: ["Move to Trash", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Move this backup to the Trash?",
    detail: path,
  };
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (response !== 0) return false;
  await shell.trashItem(path);
  return true;
}

export const revealBackup = (sourceId: string) => shell.showItemInFolder(backupPath(sourceId));

const STAT_BATCH = 256;

/** Groups a backup's files by what they are, using its Manifest.db index. */
export async function backupContents(sourceId: string): Promise<BackupContents> {
  const dir = backupPath(sourceId);
  // An encrypted backup can be listed once unlocked (its index is decrypted in memory-only temp storage).
  if ((await isEncrypted(sourceId)) && !isUnlocked(sourceId)) return { kind: "encrypted" };
  const db = new DatabaseSync(await manifestDbPath(sourceId), { readOnly: true });
  let rows: { fileID: string; domain: string; relativePath: string }[];
  let apps: number;
  try {
    // One AppDomain-<bundle id> per installed app; Group/Plugin domains are its shared folders and extensions.
    apps = Number((db.prepare("SELECT COUNT(DISTINCT domain) AS n FROM Files WHERE domain LIKE 'AppDomain-%'").get() as { n: number }).n);
    // flags = 1: regular files (2 = folders, 4 = links).
    rows = db.prepare("SELECT fileID, domain, relativePath FROM Files WHERE flags = 1").all() as typeof rows;
  } finally {
    db.close();
  }
  const categories = new Map<string, BackupCategory>();
  for (let i = 0; i < rows.length; i += STAT_BATCH) {
    const batch = rows.slice(i, i + STAT_BATCH);
    // Files are stored as <first two hex chars>/<fileID>; a missing one (skipped by iOS) counts as 0 bytes.
    const sizes = await Promise.all(batch.map((r) => stat(join(dir, r.fileID.slice(0, 2), r.fileID)).then((s) => s.size, () => 0)));
    batch.forEach((r, j) => {
      const name = backupCategory(r.domain, r.relativePath);
      const c = categories.get(name) ?? { name, files: 0, bytes: 0 };
      c.files++;
      c.bytes += sizes[j];
      categories.set(name, c);
    });
  }
  return { kind: "ok", categories: [...categories.values()].sort((a, b) => b.bytes - a.bytes), apps };
}
