// "Load from iPhone": a backup that keeps only personal data (messages, contacts, chat apps…).
//
// iOS only hands this data out inside a backup and always streams the whole backup, but our
// modified receiver (native/ddbackup) writes just the files whose phone path is on a keep-list
// and discards the rest as it arrives. The result is a small, normal backup folder (the
// "personal-data cache", source id cache:<device>) that every backup reader understands.
// It can't restore a phone; full backups under Backup & Restore do that.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_PREFIX, cacheRoot, describeBackup, reportedFailure, transferDescriber } from "./backups";
import { unlockBackup } from "./backupSource";
import { backupPercent, explainBackupOutput } from "./parse";
import { startJob } from "./tasks";
import { run, runStreaming, ToolError } from "./tools";

/** System data, matched against the path the phone reports for each file. */
const SYSTEM_PATHS = [
  "Library/SMS/", // Messages and attachments
  "Library/AddressBook/", // Contacts
  "Library/CallHistoryDB/", // Call history (encrypted backups only)
  "Library/Calendar/",
  "Library/Safari/", // Bookmarks, history
  "Library/Voicemail/",
  "Media/Recordings/", // Voice memos (older iOS)
  "Health/", // Health (encrypted backups only)
];

/** App-group containers holding the data we read: chat apps and Apple Notes. */
const GROUPS = [
  "group.net.whatsapp.WhatsApp.shared",
  "group.net.whatsapp.WhatsAppSMB.shared",
  "group.com.kik.chat",
  "group.viber.share.container",
  "group.com.apple.notes",
];
/** Apps whose own data container we keep (Viber stores its database there). */
const APP_CONTAINERS = ["com.viber"];

/**
 * App containers live under random folder ids (…/AppGroup/<UUID>/…), so the phone is asked
 * where each one is. Paths are reported as /private/var/mobile/Containers/…; the backup
 * stream reports the same folders with a different prefix, so only the tail is matched.
 */
export async function keepList(deviceId: string): Promise<string[]> {
  const xml = await run(
    "ideviceinstaller",
    ["-u", deviceId, "list", "--all", "--xml", "-a", "CFBundleIdentifier", "-a", "GroupContainers", "-a", "Container"],
    { timeoutMs: 120_000 },
  );
  const apps = JSON.parse(await run("plistutil", ["-i", "-", "-f", "json", "-C"], { input: xml })) as {
    CFBundleIdentifier?: string;
    GroupContainers?: Record<string, string>;
    Container?: string;
  }[];
  const tail = (path: string) => path.replace(/^.*\/Containers\//, "Containers/");
  const keep = new Set<string>(SYSTEM_PATHS);
  for (const app of apps) {
    for (const [group, path] of Object.entries(app.GroupContainers ?? {})) if (GROUPS.includes(group)) keep.add(`${tail(path)}/`);
    if (app.Container && APP_CONTAINERS.includes(app.CFBundleIdentifier ?? "")) keep.add(`${tail(app.Container)}/`);
  }
  return [...keep].sort();
}

const keepFile = (deviceId: string) => join(cacheRoot(), `${deviceId}.keep`);

/**
 * Loads personal data into the cache. Full the first time and whenever the keep-list changed
 * (after the first load the phone only sends changes, so a new folder would otherwise never
 * arrive); changes only otherwise.
 */
export async function loadPersonalData(deviceId: string, password?: string) {
  const keep = await keepList(deviceId);
  const previous = await readFile(keepFile(deviceId), "utf8").catch(() => undefined);
  const haveCache = !!(await stat(join(cacheRoot(), deviceId, "Manifest.db")).catch(() => undefined));
  const full = !haveCache || previous !== keep.join("\n");
  await mkdir(cacheRoot(), { recursive: true });

  startJob(deviceId, full ? "Load from iPhone (first time)" : "Load latest from iPhone", async (report, signal) => {
    const describe = transferDescriber();
    const output = await runStreaming(
      "ddbackup",
      ["-u", deviceId, "backup", ...(full ? ["--full"] : []), cacheRoot()],
      (chunk) => {
        const pct = backupPercent(chunk);
        report({ progress: pct, detail: describe(chunk) ?? "Preparing on the iPhone…" });
      },
      signal,
      { DDBACKUP_KEEP: keep.join("|") },
    ).catch((e: unknown) => {
      if (e instanceof ToolError) throw new Error(explainBackupOutput(e.output) ?? e.message);
      throw e;
    });
    const failure = reportedFailure(output);
    if (failure) throw new Error(failure);
    await writeFile(keepFile(deviceId), keep.join("\n"));
    const cache = await describeBackup(`${CACHE_PREFIX}${deviceId}`, false);
    // Unlock right away when the password was given, so the data shows without asking twice.
    if (cache?.encrypted && password) await unlockBackup(cache.sourceId, password);
  });
}

/** The cache for a device, if it has been loaded. */
// No size: nothing shows it, and measuring walks thousands of files that a running load is moving.
export const personalData = (deviceId: string) => describeBackup(`${CACHE_PREFIX}${deviceId}`, false);
