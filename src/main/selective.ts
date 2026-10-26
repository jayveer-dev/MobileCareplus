// "Choose what to save": back up (changes only), then write the chosen types as normal files.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, type BrowserWindow, dialog } from "electron";
import { BACKUP_LOCKED, type SaveType } from "../shared/types";
import { cameraRollFiles, listBookmarks, listCalendars, listCalls, listContacts, listConversations, listHealthSamples, listMessages, listNotes, listSafariHistory, messageAttachments, type BackedUpFile } from "./backupData";
import { backupEncryption, backupRoot, listBackups, reportedFailure, transferDescriber } from "./backups";
import { extractFile, isUnlocked, unlockBackup } from "./backupSource";
import { fileSafe, toBookmarksHtml, toContactsCsv, toConversationHtml, toCsv, toIcs, toVcard } from "./formats";
import { backupPercent, explainBackupOutput } from "./parse";
import { startJob } from "./tasks";
import { runStreaming, ToolError } from "./tools";

export const SAVE_TYPES: SaveType[] = ["photos", "contacts", "messages", "notes", "calendars", "bookmarks", "calls", "safariHistory", "health"];
const LABELS: Record<SaveType, string> = {
  photos: "Photos & videos",
  contacts: "Contacts",
  messages: "Messages & attachments",
  notes: "Notes",
  calendars: "Calendars",
  bookmarks: "Safari bookmarks",
  calls: "Call history",
  safariHistory: "Safari history",
  health: "Health",
};
// Only in encrypted backups; listed in the summary when the backup isn't encrypted.
const ENCRYPTED_ONLY: Partial<Record<SaveType, string>> = { calls: LABELS.calls, safariHistory: LABELS.safariHistory, health: LABELS.health };

/** "Export: Photos & videos, Contacts and 2 more" — names what's exported in the task list. */
const exportTitle = (types: SaveType[]) => {
  const names = types.map((t) => LABELS[t]);
  return `Export: ${names.length > 3 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(", ")}`;
};

const prefsFile = () => join(app.getPath("userData"), "settings.json");

async function readPrefs(): Promise<{ saveFolder?: string }> {
  try {
    return JSON.parse(await readFile(prefsFile(), "utf8"));
  } catch {
    return {};
  }
}

export async function saveFolder(): Promise<string> {
  return (await readPrefs()).saveFolder ?? join(app.getPath("documents"), "Mobile Care Plus");
}

export async function pickSaveFolder(win?: BrowserWindow): Promise<string | undefined> {
  const options: Electron.OpenDialogOptions = {
    title: "Save to",
    buttonLabel: "Use this folder",
    defaultPath: await saveFolder(),
    properties: ["openDirectory", "createDirectory"],
  };
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  const folder = picked.filePaths[0];
  if (picked.canceled || !folder) return undefined;
  await writeFile(prefsFile(), JSON.stringify({ ...(await readPrefs()), saveFolder: folder }, null, 2));
  return folder;
}

/** Avoids overwriting: "IMG_0001.HEIC" → "IMG_0001 (2).HEIC" when the name is taken in this run. */
export function uniqueName(taken: Set<string>, name: string): string {
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** Copies backup files into dir/<group>/<name>. Files iOS left out of the backup are counted, not fatal. */
async function copyFiles(sourceId: string, files: BackedUpFile[], dir: string, signal: AbortSignal, onEach: (done: number) => void) {
  const taken = new Map<string, Set<string>>();
  let missing = 0;
  for (let i = 0; i < files.length && !signal.aborted; i++) {
    const f = files[i];
    const groupDir = f.group ? join(dir, fileSafe(f.group)) : dir;
    if (!taken.has(groupDir)) {
      taken.set(groupDir, new Set());
      await mkdir(groupDir, { recursive: true });
    }
    if (!(await extractFile(sourceId, f.domain, f.relativePath, join(groupDir, uniqueName(taken.get(groupDir)!, fileSafe(f.name, "file")))))) missing++;
    onEach(i + 1);
  }
  return missing;
}

const two = (n: number) => String(n).padStart(2, "0");
/** Local date and time for folder names, e.g. "2026-10-24 00.12" (":" isn't allowed on Windows). */
export const saveStamp = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}`;

export async function saveSelected(deviceId: string, types: SaveType[], password?: string) {
  const folder = await saveFolder();
  // Encrypted backups: check the password now (against the previous backup) rather than after
  // a long backup. Without one, the renderer gets BACKUP_LOCKED and asks for it.
  const previous = (await listBackups()).find((b) => b.sourceId === deviceId);
  if (previous?.encrypted || (await backupEncryption(deviceId).catch(() => false))) {
    if (password === undefined && !isUnlocked(deviceId)) throw new Error(`${BACKUP_LOCKED}Backups for this iPhone are encrypted. Enter the backup password to save their contents.`);
    if (previous?.encrypted) await unlockBackup(deviceId, password);
  }
  startJob(deviceId, exportTitle(types), async (report, signal) => {
    // 1. Fresh backup, so the files match the phone now (only changes are copied after the first).
    const describe = transferDescriber();
    await mkdir(backupRoot(), { recursive: true });
    const output = await runStreaming(
      "idevicebackup2",
      ["-u", deviceId, "backup", backupRoot()],
      (chunk) => {
        const pct = backupPercent(chunk);
        report({ progress: pct === undefined ? undefined : pct * 0.5, detail: `Backing up · ${describe(chunk) ?? "preparing on the phone"}` });
      },
      signal,
    ).catch((e: unknown) => {
      if (e instanceof ToolError) throw new Error(explainBackupOutput(e.output) ?? e.message);
      throw e;
    });
    const failure = reportedFailure(output);
    if (failure) throw new Error(failure);
    const backup = (await listBackups()).find((b) => b.sourceId === deviceId);
    if (!backup) throw new Error("The backup didn't finish. Keep the iPhone unlocked and connected, then try again.");
    // The new backup has a new file index; keys are reused, so this is quick after the first unlock.
    if (backup.encrypted) await unlockBackup(deviceId, password);

    // 2. Write each type into "<Device> <date time>".
    const out = join(folder, fileSafe(`${backup.deviceName} ${saveStamp(new Date())}`));
    await mkdir(out, { recursive: true });
    const summary: string[] = [];
    const step = (i: number, label: string, part = 0) =>
      report({ progress: 50 + ((i + part) / types.length) * 50, detail: label });

    for (const [i, type] of types.entries()) {
      if (signal.aborted) break;
      if (type === "photos") {
        const files = await cameraRollFiles(deviceId);
        const missing = await copyFiles(deviceId, files, join(out, "Photos & videos"), signal, (n) => step(i, `Photos & videos · ${n} of ${files.length}`, n / files.length));
        summary.push(`Photos & videos: ${files.length - missing} files`);
      } else if (type === "contacts") {
        step(i, "Contacts");
        const contacts = await listContacts(deviceId);
        await writeFile(join(out, "Contacts.vcf"), toVcard(contacts));
        await writeFile(join(out, "Contacts.csv"), toContactsCsv(contacts));
        summary.push(`Contacts: ${contacts.length} (Contacts.vcf, Contacts.csv)`);
      } else if (type === "messages") {
        const dir = join(out, "Messages");
        await mkdir(dir, { recursive: true });
        const chats = await listConversations(deviceId);
        const taken = new Set<string>();
        for (const [n, c] of chats.entries()) {
          if (signal.aborted) break;
          if (n % 25 === 0) step(i, `Messages · ${n} of ${chats.length} conversations`, (n / chats.length) * 0.5);
          await writeFile(join(dir, uniqueName(taken, `${fileSafe(c.title, "Conversation")}.html`)), toConversationHtml(c.title, await listMessages(deviceId, c.id)));
        }
        const files = await messageAttachments(deviceId);
        const missing = await copyFiles(deviceId, files, join(dir, "Attachments"), signal, (n) => step(i, `Message attachments · ${n} of ${files.length}`, 0.5 + (n / files.length) * 0.5));
        summary.push(`Messages: ${chats.length} conversations, ${files.length - missing} attachments`);
      } else if (type === "notes") {
        step(i, "Notes");
        const { notes, locked } = await listNotes(deviceId);
        const taken = new Map<string, Set<string>>();
        for (const n of notes) {
          const dir = join(out, "Notes", fileSafe(n.folder, "Notes"));
          if (!taken.has(dir)) {
            taken.set(dir, new Set());
            await mkdir(dir, { recursive: true });
          }
          const header = [n.title, n.created && `Created ${new Date(n.created).toLocaleString()}`, n.modified && `Modified ${new Date(n.modified).toLocaleString()}`].filter(Boolean).join("\n");
          await writeFile(join(dir, uniqueName(taken.get(dir)!, `${fileSafe(n.title)}.txt`)), `${header}\n\n${n.text}\n`);
        }
        summary.push(`Notes: ${notes.length}${locked ? ` (${locked} locked ${locked === 1 ? "note" : "notes"} left out; they're encrypted on the phone)` : ""}`);
      } else if (type === "calendars") {
        step(i, "Calendars");
        const calendars = await listCalendars(deviceId);
        await mkdir(join(out, "Calendars"), { recursive: true });
        let events = 0;
        const taken = new Set<string>();
        for (const [name, list] of calendars) {
          events += list.length;
          await writeFile(join(out, "Calendars", uniqueName(taken, `${fileSafe(name, "Calendar")}.ics`)), toIcs(name, list));
        }
        summary.push(`Calendars: ${calendars.size} calendars, ${events} events (.ics files)`);
      } else if (type === "bookmarks") {
        step(i, "Safari bookmarks");
        const { tree, count } = await listBookmarks(deviceId);
        await writeFile(join(out, "Safari bookmarks.html"), toBookmarksHtml(tree));
        summary.push(`Safari bookmarks: ${count} (import into any browser)`);
      } else if (!backup.encrypted) {
        // calls / safariHistory / health: iOS only puts these in encrypted backups.
        summary.push(`${ENCRYPTED_ONLY[type]}: not saved, iOS only includes it in encrypted backups (turn on Encrypt backups).`);
      } else if (type === "calls") {
        step(i, "Call history");
        const calls = await listCalls(deviceId);
        await writeFile(
          join(out, "Call history.csv"),
          toCsv(["Date", "Direction", "Name", "Number", "Duration (seconds)", "Type"], calls.map((c) => [c.date ? new Date(c.date).toLocaleString() : "", c.direction, c.name ?? "", c.number, String(c.seconds), c.kind])),
        );
        summary.push(`Call history: ${calls.length} calls (Call history.csv)`);
      } else if (type === "safariHistory") {
        step(i, "Safari history");
        const visits = await listSafariHistory(deviceId);
        await writeFile(join(out, "Safari history.csv"), toCsv(["Date", "Title", "Address"], visits.map((v) => [v.date ? new Date(v.date).toLocaleString() : "", v.title, v.url])));
        summary.push(`Safari history: ${visits.length} visits (Safari history.csv)`);
      } else if (type === "health") {
        step(i, "Health");
        const samples = await listHealthSamples(deviceId);
        await writeFile(join(out, "Health.csv"), toCsv(["Type", "Start", "End", "Value", "Unit"], samples.map((s) => [s.type, s.start ?? "", s.end ?? "", String(s.value), s.unit])));
        summary.push(`Health: ${samples.length} measurements (Health.csv; workouts and sleep aren't included yet)`);
      }
    }
    if (signal.aborted) return;
    await writeFile(
      join(out, "What was saved.txt"),
      `Saved by Mobile Care Plus from ${backup.deviceName} on ${new Date().toLocaleString()}.\n\n${summary.join("\n")}\n`,
    );
    return out;
  });
  // Surface "folder missing / not writable" now rather than after a long backup.
  await stat(folder).catch(() => mkdir(folder, { recursive: true }));
}
