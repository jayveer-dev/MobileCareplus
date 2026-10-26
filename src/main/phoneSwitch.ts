// Move to a new phone: copies the chosen kinds of data from one connected phone to another.
// Built so far: photos and videos to an Android phone. Each item passes through a temporary file
// on this computer, one at a time, so a big library needs almost no free space here.
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Contact, Platform } from "../shared/types";
import { phonePath } from "./androidPhotos";
import { androidCalendars, androidContacts } from "./androidPim";
import { listCalendars, listContacts } from "./backupData";
import { isUnlocked, workDir } from "./backupSource";
import { type CalendarEvent, fileSafe, toIcs, toVcard } from "./formats";
import { CACHE_PREFIX } from "./backups";
import { personalData } from "./lightLoad";
import { parseAndroidLongList } from "./parse";
import { copyFromPhone, photoLibrary } from "./photoLibrary";
import { startJob } from "./tasks";
import { run } from "./tools";

/** One argument for the phone's shell, whatever it contains (phone names have apostrophes). */
export const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export interface Phone {
  platform: Platform;
  id: string;
  name: string;
}

export interface SwitchSummary {
  photos?: { count: number; bytes: number };
  contacts?: number;
  /** Calendar events across all calendars. */
  events?: number;
  /** iPhone only: its data isn't loaded (or is locked), so contacts and calendar can't be read yet. */
  needsLoad?: boolean;
}

/** iPhone contacts and calendars come from the personal-data load; null = not loaded or locked. */
async function iosSource(id: string): Promise<string | null> {
  const cache = await personalData(id);
  if (!cache || (cache.encrypted && !isUnlocked(cache.sourceId))) return null;
  return `${CACHE_PREFIX}${id}`;
}

async function readContacts(source: Phone): Promise<Contact[] | null> {
  if (source.platform === "android") return androidContacts(source.id);
  const cache = await iosSource(source.id);
  return cache ? listContacts(cache) : null;
}

async function readCalendars(source: Phone): Promise<Map<string, CalendarEvent[]> | null> {
  if (source.platform === "android") return androidCalendars(source.id);
  const cache = await iosSource(source.id);
  return cache ? listCalendars(cache) : null;
}

/** What the source phone has, for the checklist. Hidden and deleted items stay behind, as in Photos. */
export async function switchSummary(source: Phone): Promise<SwitchSummary> {
  const [library, contacts, calendars] = await Promise.all([
    photoLibrary(source.platform, source.id).catch(() => undefined),
    readContacts(source).catch(() => undefined),
    readCalendars(source).catch(() => undefined),
  ]);
  const items = library?.assets.filter((a) => !a.deleted && !a.hidden);
  return {
    photos: items && { count: items.length, bytes: items.reduce((s, a) => s + (a.bytes ?? 0), 0) },
    contacts: contacts?.length ?? undefined,
    events: calendars ? [...calendars.values()].reduce((s, e) => s + e.length, 0) : undefined,
    needsLoad: source.platform === "ios" && contacts === null,
  };
}

const NEEDS_LOAD = "The iPhone's contacts and calendar come from its backup: load it first (Manage › Contacts › Load from iPhone in the main app), then try again.";

/** Puts a file on the phone's Download folder and opens it there, so its own app imports it. */
export async function pushAndOpen(dest: Phone, name: string, text: string, mime: string) {
  const tmp = join(workDir(), "switch", `${Date.now()}-${name}`);
  await mkdir(join(tmp, ".."), { recursive: true });
  await writeFile(tmp, text);
  try {
    await run("adb", ["-s", dest.id, "push", tmp, phonePath(`Download/${name}`)], { timeoutMs: 5 * 60_000 });
  } finally {
    await rm(tmp, { force: true });
  }
  // Through the documents provider: plain file:// links are refused by modern Android.
  const uri = `content://com.android.externalstorage.documents/document/${encodeURIComponent(`primary:Download/${name}`)}`;
  await run("adb", ["-s", dest.id, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", uri, "-t", mime, "--grant-read-uri-permission"], { timeoutMs: 60_000 });
}

/** Contacts to an Android phone: a vCard it imports after one tap on its screen. */
export async function moveContacts(source: Phone, dest: Phone): Promise<void> {
  if (dest.platform !== "android") throw new Error("Moving contacts into an iPhone isn't available yet.");
  const contacts = await readContacts(source);
  if (contacts === null) throw new Error(NEEDS_LOAD);
  if (contacts.length === 0) throw new Error("No contacts to move.");
  startJob(dest.id, `Move ${contacts.length.toLocaleString()} contacts to ${dest.name}`, async (report) => {
    report({ progress: 30, detail: "Copying to the phone" });
    await pushAndOpen(dest, `Contacts from ${fileSafe(source.name, "old phone")}.vcf`, toVcard(contacts), "text/x-vcard");
    report({ progress: 100, detail: "Tap Import on the new phone" });
  });
}

/** Calendar to an Android phone: one .ics per calendar, each confirmed with a tap on its screen. */
export async function moveCalendar(source: Phone, dest: Phone): Promise<void> {
  if (dest.platform !== "android") throw new Error("Moving the calendar into an iPhone isn't available yet.");
  const calendars = await readCalendars(source);
  if (calendars === null) throw new Error(NEEDS_LOAD);
  const real = [...calendars.entries()].filter(([, events]) => events.length > 0);
  if (real.length === 0) throw new Error("No calendar events to move.");
  startJob(dest.id, `Move calendar to ${dest.name}`, async (report, signal) => {
    for (const [i, [name, events]] of real.entries()) {
      if (signal.aborted) throw new Error("Cancelled");
      report({ progress: (i / real.length) * 100, detail: `${name}: tap Save on the new phone` });
      await pushAndOpen(dest, `${fileSafe(name, "Calendar")} from ${fileSafe(source.name, "old phone")}.ics`, toIcs(name, events), "text/calendar");
    }
  });
}

/** Photos and videos into an album named after the old phone: DCIM/<old phone name>/ on the new one. */
export async function movePhotos(source: Phone, dest: Phone): Promise<void> {
  if (dest.platform !== "android") throw new Error("Moving photos into an iPhone isn't available yet.");
  const items = (await photoLibrary(source.platform, source.id)).assets.filter((a) => !a.deleted && !a.hidden).reverse(); // oldest first
  const album = fileSafe(source.name, "Old phone");
  const folder = `DCIM/${album}`;
  await run("adb", ["-s", dest.id, "shell", `mkdir -p ${shellQuote(phonePath(folder))}`]);
  // Already there with the same size = copied by an earlier run; skip so a re-run resumes.
  const there = new Map(parseAndroidLongList(await run("adb", ["-s", dest.id, "shell", `ls -l ${shellQuote(phonePath(folder))}`], { timeoutMs: 60_000 })).map((f) => [f.name.toLowerCase(), f.size]));
  const total = items.reduce((s, a) => s + (a.bytes ?? 0), 0);

  startJob(dest.id, `Move photos & videos to ${dest.name}`, async (report, signal) => {
    const tmp = join(workDir(), "switch", dest.id);
    await mkdir(tmp, { recursive: true });
    const taken = new Set<string>();
    let done = 0;
    let bytes = 0;
    let skipped = 0;
    let failed = 0;
    for (const item of items) {
      if (signal.aborted) throw new Error("Cancelled");
      // Same name twice (IMG numbers restart): add " (2)", as Export does.
      let name = fileSafe(item.name, "photo");
      const dot = name.lastIndexOf(".");
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${dot > 0 ? name.slice(0, dot) : name} (${n})${dot > 0 ? name.slice(dot) : ""}`;
      taken.add(name.toLowerCase());
      if (item.bytes && there.get(name.toLowerCase()) === item.bytes) skipped++;
      else {
        const local = join(tmp, name);
        try {
          await copyFromPhone(source.id, item, local, 10 * 60_000);
          // The Gallery sorts pictures without a capture date by file time; keep the original's.
          if (item.date) await utimes(local, new Date(item.date), new Date(item.date)).catch(() => {});
          await run("adb", ["-s", dest.id, "push", local, phonePath(`${folder}/${name}`)], { timeoutMs: 10 * 60_000 });
        } catch {
          failed++; // e.g. an iPhone photo kept only in iCloud; the summary says how many
        } finally {
          await rm(local, { force: true });
        }
      }
      done++;
      bytes += item.bytes ?? 0;
      report({
        progress: total ? (bytes / total) * 100 : (done / items.length) * 100,
        detail: `${done.toLocaleString()} of ${items.length.toLocaleString()}${skipped ? `, ${skipped.toLocaleString()} already there` : ""}${failed ? `, ${failed} couldn't be copied` : ""}`,
      });
    }
    // Let the new phone's Gallery see the new files now rather than at its next scan.
    await run("adb", ["-s", dest.id, "shell", "content", "call", "--uri", "content://media", "--method", "scan_volume", "--arg", "external_primary"], { timeoutMs: 5 * 60_000 }).catch(() => {});
    if (failed) throw new Error(`${failed.toLocaleString()} of ${items.length.toLocaleString()} items couldn't be copied (on iPhone, usually ones kept only in iCloud). Run it again to retry them; the rest are skipped.`);
  });
}
