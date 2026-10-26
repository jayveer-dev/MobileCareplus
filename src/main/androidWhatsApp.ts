// WhatsApp, WhatsApp Business and GBWhatsApp on Android, over adb (USB debugging on).
// The chats themselves live in the app's private storage; what we can reach is WhatsApp's own
// end-to-end encrypted chat backup (msgstore.db.crypt15) and the Media folder in shared storage.
// Reading the backup needs the user's 64-digit key (docs/TRANSFER-DESIGN.md, "crypt15 codec").
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isChatBackup, parseAndroidLongList } from "./parse";
import { run, runStreaming } from "./tools";
import { savedRoot, type ChatApp } from "./whatsapp";

export type AndroidWaApp = ChatApp;

const ANDROID: Record<AndroidWaApp, { pkg: string; folder: string }> = {
  whatsapp: { pkg: "com.whatsapp", folder: "WhatsApp" },
  business: { pkg: "com.whatsapp.w4b", folder: "WhatsApp Business" },
  gbwhatsapp: { pkg: "com.gbwhatsapp", folder: "GBWhatsApp" },
};

/** Android 11+ keeps the folder under Android/media; older phones at the top of shared storage. */
const roots = (a: AndroidWaApp) => [`/sdcard/Android/media/${ANDROID[a].pkg}/${ANDROID[a].folder}`, `/sdcard/${ANDROID[a].folder}`];

export interface AndroidWaStatus {
  installed: boolean;
  /** WhatsApp's newest chat backup on the phone, if any. */
  backup?: { name: string; date: string; bytes: number; encryption: string };
}

const shell = (id: string, command: string) => run("adb", ["-s", id, "shell", command], { timeoutMs: 30_000 });

/** The app's folder on the phone that has a Databases folder, newest backup first. */
async function findBackup(id: string, appId: AndroidWaApp) {
  for (const root of roots(appId)) {
    const files = parseAndroidLongList(await shell(id, `ls -l '${root}/Databases' 2>/dev/null`).catch(() => "")).filter((f) => !f.isDir && isChatBackup(f.name));
    if (files.length === 0) continue;
    // msgstore.db.cryptNN is the latest; dated copies (msgstore-YYYY-MM-DD.1…) are older ones.
    const newest = files.find((f) => f.name.startsWith("msgstore.db.")) ?? files.sort((a, b) => b.date.localeCompare(a.date))[0];
    return { root, file: newest };
  }
  return undefined;
}

export async function androidWhatsApp(id: string, appId: AndroidWaApp): Promise<AndroidWaStatus> {
  const installed = (await shell(id, `pm path ${ANDROID[appId].pkg}`).catch(() => "")).startsWith("package:");
  const found = await findBackup(id, appId);
  if (!found) return { installed };
  const { file } = found;
  return { installed, backup: { name: file.name, date: file.date, bytes: file.size, encryption: file.name.slice(file.name.lastIndexOf(".") + 1) } };
}

/** Copies only the newest chat backup file into dir (for reading with the key, without the media). */
export async function pullAndroidBackup(id: string, appId: AndroidWaApp, dir: string) {
  const found = await findBackup(id, appId);
  if (!found) throw new Error(`No ${ANDROID[appId].folder} chat backup on this phone. In the app: Settings › Chats › Chat backup › Back up, then try again.`);
  await mkdir(dir, { recursive: true });
  await run("adb", ["-s", id, "pull", "-a", `${found.root}/Databases/${found.file.name}`, dir], { timeoutMs: 10 * 60_000 });
}

/**
 * Back up: copies WhatsApp's backup (Databases) plus Media and Backups (settings, stickers) from the
 * phone into a dated folder. The chats stay encrypted with the user's key, exactly as on the phone.
 */
export async function saveAndroidWhatsApp(id: string, appId: AndroidWaApp, deviceName: string, signal: AbortSignal, onStep: (step: string, progress: number) => void): Promise<string> {
  const found = await findBackup(id, appId);
  if (!found) throw new Error(`No ${ANDROID[appId].folder} chat backup on this phone. In the app: Settings › Chats › Chat backup › Back up, then try again.`);
  const dir = join(savedRoot(appId), new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  const parts: [string, string, boolean][] = [
    ["Databases", "chat backup", true],
    ["Backups", "settings", false],
    ["Media", "photos, videos and voice notes", false],
  ];
  for (const [i, [folder, what, required]] of parts.entries()) {
    if (signal.aborted) throw new Error("Cancelled");
    onStep(`Copying ${what}`, (i / parts.length) * 100);
    await runStreaming("adb", ["-s", id, "pull", "-a", `${found.root}/${folder}`, dir], () => {}, signal).catch((e) => {
      if (required || signal.aborted) throw e; // Media or Backups may simply not exist
    });
  }
  const info = { date: new Date().toISOString(), deviceName, platform: "android", backupFile: found.file.name, backupDate: found.file.date };
  await writeFile(join(dir, "backup.json"), JSON.stringify(info, null, 2));
  return dir;
}
