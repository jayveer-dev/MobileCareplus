// Android "Back up to computer": copies the chosen kinds off the phone as normal files, into the
// same dated folders as the iPhone's "Save as files". No whole-phone backup exists on Android
// (Google removed computer backups, and apps can't be copied out), so this is the honest version:
// everything reachable, saved in formats any program opens.
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserWindow, dialog, shell } from "electron";
import { phonePath } from "./androidPhotos";
import { androidCalendars, androidContacts } from "./androidPim";
import { parseAndroidLongList } from "./parse";
import { pushAndOpen, shellQuote } from "./phoneSwitch";
import { toContactsCsv, toIcs, toVcard, fileSafe } from "./formats";
import { copyFromPhone, photoLibrary } from "./photoLibrary";
import { run } from "./tools";
import { saveFolder, saveStamp, uniqueName } from "./selective";
import { startJob } from "./tasks";

export type AndroidSaveType = "photos" | "contacts" | "calendars";
const LABELS: Record<AndroidSaveType, string> = { photos: "Photos & videos", contacts: "Contacts", calendars: "Calendars" };

export interface AndroidSaveCounts {
  photos?: { count: number; bytes: number };
  contacts?: number;
  events?: number;
}

/** What the phone has, for the screen's labels. */
export async function androidSaveCounts(id: string): Promise<AndroidSaveCounts> {
  const [library, contacts, calendars] = await Promise.all([
    photoLibrary("android", id).catch(() => undefined),
    androidContacts(id).catch(() => undefined),
    androidCalendars(id).catch(() => undefined),
  ]);
  const items = library?.assets.filter((a) => !a.deleted && !a.hidden);
  return {
    photos: items && { count: items.length, bytes: items.reduce((s, a) => s + (a.bytes ?? 0), 0) },
    contacts: contacts?.length,
    events: calendars && [...calendars.values()].reduce((s, e) => s + e.length, 0),
  };
}

/** Writes each chosen type into "<Phone name> <date time>" inside the save folder. */
export async function saveAndroidSelected(id: string, deviceName: string, types: AndroidSaveType[]) {
  const folder = await saveFolder();
  const names = types.map((t) => LABELS[t]);
  startJob(id, `Export: ${names.join(", ")}`, async (report, signal) => {
    const out = join(folder, fileSafe(`${deviceName} ${saveStamp(new Date())}`));
    await mkdir(out, { recursive: true });

    if (types.includes("contacts")) {
      report({ detail: "Contacts" });
      const contacts = await androidContacts(id);
      const dir = join(out, "Contacts");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "Contacts.vcf"), toVcard(contacts));
      await writeFile(join(dir, "Contacts.csv"), toContactsCsv(contacts));
    }
    if (types.includes("calendars") && !signal.aborted) {
      report({ detail: "Calendars" });
      const dir = join(out, "Calendars");
      await mkdir(dir, { recursive: true });
      const taken = new Set<string>();
      for (const [name, events] of await androidCalendars(id)) {
        if (events.length > 0) await writeFile(join(dir, uniqueName(taken, `${fileSafe(name, "Calendar")}.ics`)), toIcs(name, events));
      }
    }
    if (types.includes("photos") && !signal.aborted) {
      const items = (await photoLibrary("android", id)).assets.filter((a) => !a.deleted && !a.hidden);
      const dir = join(out, "Photos & videos");
      await mkdir(dir, { recursive: true });
      const total = items.reduce((s, a) => s + (a.bytes ?? 0), 0);
      const taken = new Set<string>();
      let bytes = 0;
      let failed = 0;
      for (const [i, item] of items.entries()) {
        if (signal.aborted) break;
        await copyFromPhone(id, item, join(dir, uniqueName(taken, fileSafe(item.name, "photo"))), 10 * 60_000).catch(() => failed++);
        bytes += item.bytes ?? 0;
        report({ progress: total ? (bytes / total) * 100 : undefined, detail: `${i + 1} of ${items.length} · ${item.name}` });
      }
      if (failed) throw new Error(`${failed} of ${items.length} items couldn't be copied; the rest are in the folder.`);
    }
    return out;
  });
}

// ---- Saves on this computer, and putting them back on a phone.

export interface AndroidSavedFolder {
  dir: string;
  name: string;
  /** Folder modification time. */
  date: string;
  photos: number;
  contacts: boolean;
  calendars: number;
}

/** Export folders inside the save folder (one level deep): any folder with one of our three parts. */
export async function listAndroidSaves(): Promise<AndroidSavedFolder[]> {
  const root = await saveFolder();
  const out: AndroidSavedFolder[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const [allPhotos, contacts, calendars] = await Promise.all([
      readdir(join(dir, "Photos & videos")).catch(() => [] as string[]),
      stat(join(dir, "Contacts", "Contacts.vcf")).then(() => true, () => false),
      readdir(join(dir, "Calendars")).catch(() => [] as string[]),
    ]);
    const photos = allPhotos.filter((n) => !n.startsWith("."));
    const ics = calendars.filter((n) => n.endsWith(".ics")).length;
    if (photos.length === 0 && !contacts && ics === 0) continue;
    out.push({ dir, name: entry.name, date: (await stat(dir)).mtime.toISOString(), photos: photos.length, contacts, calendars: ics });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** Membership check, so restore and reveal only touch folders the list showed. */
async function savedFolder(dir: string): Promise<AndroidSavedFolder> {
  const found = (await listAndroidSaves()).find((s) => s.dir === dir);
  if (!found) throw new Error("Unknown save folder.");
  return found;
}

export async function revealAndroidSave(dir: string) {
  shell.showItemInFolder((await savedFolder(dir)).dir);
}

/**
 * Restore to a connected Android phone: photos go into a Gallery album named after the save folder,
 * contacts and calendars open on the phone for its own apps to import (a tap each). Running it
 * again only copies missing photos.
 */
export async function restoreAndroidSave(dir: string, id: string, deviceName: string, win?: BrowserWindow): Promise<boolean> {
  const save = await savedFolder(dir);
  const parts = [save.photos > 0 && `${save.photos} photos and videos`, save.contacts && "contacts", save.calendars > 0 && "calendars"].filter(Boolean).join(", ");
  const options: Electron.MessageBoxOptions = {
    type: "question",
    buttons: ["Restore", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Restore "${save.name}" to ${deviceName}?`,
    detail: `Copies ${parts} to the phone. Nothing on the phone is deleted; contacts and calendars ask you to confirm the import on the phone.`,
  };
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (response !== 0) return false;
  const dest = { platform: "android" as const, id, name: deviceName };
  startJob(id, `Restore "${save.name}" to ${deviceName}`, async (report, signal) => {
    if (save.contacts) {
      report({ detail: "Contacts · tap Import on the phone" });
      await pushAndOpen(dest, `${fileSafe(save.name, "Contacts")}.vcf`, await readFile(join(dir, "Contacts", "Contacts.vcf"), "utf8"), "text/x-vcard");
    }
    if (save.calendars && !signal.aborted) {
      for (const name of (await readdir(join(dir, "Calendars"))).filter((n) => n.endsWith(".ics"))) {
        if (signal.aborted) break;
        report({ detail: `${name.slice(0, -4)} · tap Save on the phone` });
        await pushAndOpen(dest, name, await readFile(join(dir, "Calendars", name), "utf8"), "text/calendar");
      }
    }
    if (save.photos && !signal.aborted) {
      const from = join(dir, "Photos & videos");
      const names = (await readdir(from)).filter((n) => !n.startsWith("."));
      const album = `DCIM/${fileSafe(save.name, "Restored")}`;
      await run("adb", ["-s", id, "shell", `mkdir -p ${shellQuote(phonePath(album))}`]);
      const there = new Map(parseAndroidLongList(await run("adb", ["-s", id, "shell", `ls -l ${shellQuote(phonePath(album))}`], { timeoutMs: 60_000 })).map((f) => [f.name, f.size]));
      for (const [i, name] of names.entries()) {
        if (signal.aborted) break;
        if (there.get(name) !== (await stat(join(from, name))).size) await run("adb", ["-s", id, "push", join(from, name), phonePath(`${album}/${name}`)], { timeoutMs: 10 * 60_000 });
        report({ progress: ((i + 1) / names.length) * 100, detail: `${i + 1} of ${names.length} photos` });
      }
      await run("adb", ["-s", id, "shell", "content", "call", "--uri", "content://media", "--method", "scan_volume", "--arg", "external_primary"], { timeoutMs: 5 * 60_000 }).catch(() => {});
    }
  });
  return true;
}
