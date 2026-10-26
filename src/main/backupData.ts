// Reads contacts, messages and other app data out of an iPhone backup (decrypted by backupSource).
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { app, type BrowserWindow, dialog } from "electron";
import type { ChatMessage, Contact, Conversation } from "../shared/types";
import { backupPath } from "./backups";
import { type BookmarkNode, type CalendarEvent, fileSafe, toContactsCsv, toConversationHtml, toVcard } from "./formats";
import { extractFile, fileId, localKey, manifestDbPath, workDir } from "./backupSource";
import { appleTime, attributedBodyText, contactLabel, handleKey, noteText } from "./parse";

const ADDRESS_BOOK = "Library/AddressBook/AddressBook.sqlitedb";
const SMS = "Library/SMS/sms.db";
// ABMultiValue.property values for phone numbers and email addresses.
const AB_PHONE = 3;
const AB_EMAIL = 4;
// associated_message_type 2000–3999 are tapback reactions and their removals, not messages.
// message.date is nanoseconds on newer iOS (too big for a JS number), seconds on older; convert in SQL.
const SECONDS = (col: string) => `(CASE WHEN ${col} > 1000000000000 THEN ${col} / 1000000000 ELSE ${col} END)`;
const IS_REAL_MESSAGE = "(m.associated_message_type IS NULL OR m.associated_message_type < 2000 OR m.associated_message_type >= 4000)";

/**
 * Extracts a database and its WAL journal under their real names (decrypting if needed), so
 * SQLite applies recent changes still in the journal. Reuses the copy while the backup is unchanged.
 */
async function openDb(sourceId: string, relativePath: string, domain = "HomeDomain"): Promise<DatabaseSync> {
  const backupMtime = (await stat(join(backupPath(sourceId), "Manifest.db"))).mtimeMs;
  const dir = join(workDir(), localKey(sourceId), fileId(domain, relativePath), String(backupMtime));
  const local = join(dir, relativePath.split("/").at(-1)!);
  if (!(await stat(local).catch(() => undefined))) {
    await mkdir(dir, { recursive: true });
    if (!(await extractFile(sourceId, domain, relativePath, local)))
      throw new Error("This backup doesn't contain that data. Data kept in iCloud, or a feature that's turned off, can leave it out.");
    await extractFile(sourceId, domain, `${relativePath}-wal`, `${local}-wal`);
  }
  return new DatabaseSync(local);
}

export async function withDb<T>(sourceId: string, relativePath: string, read: (db: DatabaseSync) => T, domain?: string): Promise<T> {
  const db = await openDb(sourceId, relativePath, domain);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

type Row = Record<string, string | number | bigint | Uint8Array | null>;
const str = (v: Row[string]) => (v === null || v === undefined ? "" : String(v));

export function listContacts(sourceId: string): Promise<Contact[]> {
  return withDb(sourceId, ADDRESS_BOOK, (db) => {
    const people = db.prepare("SELECT ROWID AS id, First, Middle, Last, Organization, Nickname FROM ABPerson").all() as Row[];
    const values = db
      .prepare(
        `SELECT mv.record_id AS id, mv.property, mv.value, l.value AS label
         FROM ABMultiValue mv LEFT JOIN ABMultiValueLabel l ON l.ROWID = mv.label
         WHERE mv.property IN (${AB_PHONE}, ${AB_EMAIL}) AND mv.value IS NOT NULL`,
      )
      .all() as Row[];
    const byPerson = new Map<number, Row[]>();
    for (const v of values) byPerson.set(Number(v.id), [...(byPerson.get(Number(v.id)) ?? []), v]);
    return people
      .map((p): Contact => {
        const own = byPerson.get(Number(p.id)) ?? [];
        const pick = (prop: number) => own.filter((v) => Number(v.property) === prop).map((v) => ({ label: contactLabel(str(v.label)), value: str(v.value) }));
        const phones = pick(AB_PHONE);
        const emails = pick(AB_EMAIL);
        const name = [p.First, p.Middle, p.Last].map(str).filter(Boolean).join(" ") || str(p.Nickname) || str(p.Organization) || phones[0]?.value || emails[0]?.value || "No name";
        return { id: Number(p.id), name, organization: str(p.Organization) || undefined, phones, emails };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

/** Phone/email → contact name, for labelling message senders. */
async function nameBook(sourceId: string): Promise<Map<string, string>> {
  const book = new Map<string, string>();
  const contacts = await listContacts(sourceId).catch(() => []);
  for (const c of contacts) for (const v of [...c.phones, ...c.emails]) book.set(handleKey(v.value), c.name);
  return book;
}

export async function listConversations(sourceId: string): Promise<Conversation[]> {
  const book = await nameBook(sourceId);
  return withDb(sourceId, SMS, (db) => {
    const chats = db
      .prepare(
        `SELECT c.ROWID AS id, c.display_name AS name, c.chat_identifier AS ident, c.service_name AS service,
                COUNT(m.ROWID) AS n, MAX(${SECONDS("m.date")}) AS last
         FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID JOIN message m ON m.ROWID = cmj.message_id
         WHERE ${IS_REAL_MESSAGE}
         GROUP BY c.ROWID ORDER BY last DESC`,
      )
      .all() as Row[];
    const members = db.prepare("SELECT chj.chat_id AS chat, h.id AS handle FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id").all() as Row[];
    const byChat = new Map<number, string[]>();
    for (const m of members) byChat.set(Number(m.chat), [...(byChat.get(Number(m.chat)) ?? []), str(m.handle)]);
    return chats.map((c) => {
      const handles = byChat.get(Number(c.id)) ?? [str(c.ident)];
      const participants = handles.map((h) => book.get(handleKey(h)) ?? h);
      return {
        id: Number(c.id),
        title: str(c.name) || participants.join(", ") || str(c.ident),
        participants,
        messages: Number(c.n),
        lastDate: appleTime(c.last as number),
        service: str(c.service) || undefined,
      };
    });
  });
}

export async function listMessages(sourceId: string, chatId: number): Promise<ChatMessage[]> {
  const book = await nameBook(sourceId);
  return withDb(sourceId, SMS, (db) => {
    const rows = db
      .prepare(
        `SELECT m.ROWID AS id, m.text, m.attributedBody AS body, ${SECONDS("m.date")} AS date, m.is_from_me AS me, h.id AS handle
         FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN handle h ON h.ROWID = m.handle_id
         WHERE cmj.chat_id = ? AND ${IS_REAL_MESSAGE}
         ORDER BY m.date, m.ROWID`,
      )
      .all(chatId) as Row[];
    const files = db
      .prepare(
        `SELECT maj.message_id AS id, COALESCE(a.transfer_name, a.filename) AS name
         FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id
         JOIN chat_message_join cmj ON cmj.message_id = maj.message_id WHERE cmj.chat_id = ?`,
      )
      .all(chatId) as Row[];
    const byMessage = new Map<number, string[]>();
    for (const f of files) byMessage.set(Number(f.id), [...(byMessage.get(Number(f.id)) ?? []), str(f.name).split("/").at(-1)!]);
    return rows.map((r) => {
      const fromMe = Number(r.me) === 1;
      // U+FFFC marks where an attachment sits inline; the attachment list already names it.
      const text = (str(r.text) || attributedBodyText(r.body as Uint8Array | null) || "").replace(/￼/g, "").trim();
      return {
        id: Number(r.id),
        date: appleTime(r.date as number),
        fromMe,
        sender: fromMe ? undefined : book.get(handleKey(str(r.handle))) ?? (str(r.handle) || undefined),
        text,
        attachments: byMessage.get(Number(r.id)) ?? [],
      };
    });
  });
}

async function saveAs(win: BrowserWindow | undefined, defaultName: string, filters: Electron.FileFilter[], content: () => Promise<string>) {
  const options: Electron.SaveDialogOptions = { defaultPath: join(app.getPath("documents"), defaultName), filters };
  const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (picked.canceled || !picked.filePath) return false;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(picked.filePath, await content(), "utf8");
  return true;
}


export function exportContacts(sourceId: string, format: "vcf" | "csv", win?: BrowserWindow) {
  return format === "vcf"
    ? saveAs(win, "Contacts.vcf", [{ name: "vCard", extensions: ["vcf"] }], async () => toVcard(await listContacts(sourceId)))
    : saveAs(win, "Contacts.csv", [{ name: "Spreadsheet (CSV)", extensions: ["csv"] }], async () => toContactsCsv(await listContacts(sourceId)));
}

export async function exportConversation(sourceId: string, chatId: number, win?: BrowserWindow) {
  const chat = (await listConversations(sourceId)).find((c) => c.id === chatId);
  if (!chat) throw new Error("Conversation not found in this backup.");
  return saveAs(win, `${fileSafe(chat.title, "Conversation")}.html`, [{ name: "Web page", extensions: ["html"] }], async () =>
    toConversationHtml(chat.title, await listMessages(sourceId, chatId)),
  );
}

export interface Note {
  title: string;
  folder: string;
  created?: string;
  modified?: string;
  text: string;
}

/** Notes app, without the Recently Deleted folder; locked notes are encrypted on the phone and are counted, not read. */
export async function listNotes(sourceId: string): Promise<{ notes: Note[]; locked: number }> {
  const { gunzipSync } = await import("node:zlib");
  return withDb(
    sourceId,
    "NoteStore.sqlite",
    (db) => {
      const rows = db
        .prepare(
          `SELECT n.ZTITLE1 AS title, f.ZTITLE2 AS folder, n.ZCREATIONDATE1 AS created, n.ZMODIFICATIONDATE1 AS modified,
                  n.ZISPASSWORDPROTECTED AS locked, d.ZDATA AS data
           FROM ZICCLOUDSYNCINGOBJECT n JOIN ZICNOTEDATA d ON d.Z_PK = n.ZNOTEDATA
           LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER
           WHERE COALESCE(n.ZMARKEDFORDELETION, 0) = 0 AND d.ZDATA IS NOT NULL
             AND COALESCE(f.ZFOLDERTYPE, 0) != 1` /* folder type 1 = Recently Deleted */,
        )
        .all() as Row[];
      let locked = 0;
      const notes: Note[] = [];
      for (const r of rows) {
        if (Number(r.locked) === 1) {
          locked++;
          continue;
        }
        const text = noteText(r.data as Uint8Array, gunzipSync);
        if (text === undefined) continue;
        notes.push({ title: str(r.title) || text.split("\n")[0] || "Untitled", folder: str(r.folder) || "Notes", created: appleTime(r.created as number), modified: appleTime(r.modified as number), text });
      }
      return { notes, locked };
    },
    "AppDomainGroup-group.com.apple.notes",
  );
}

// Calendar.sqlitedb Recurrence.frequency: 1 daily, 2 weekly, 3 monthly, 4 yearly.
const FREQ = ["", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"];

/**
 * Calendar events grouped by calendar. Repeats keep frequency, interval, count and end date;
 * ponytail: day-of-week/month rules (Recurrence.specifier) aren't converted yet, so "every
 * 2nd Tuesday" exports as repeating on the first event's weekday.
 */
export function listCalendars(sourceId: string): Promise<Map<string, CalendarEvent[]>> {
  return withDb(sourceId, "Library/Calendar/Calendar.sqlitedb", (db) => {
    const rows = db
      .prepare(
        `SELECT ci.ROWID AS id, ci.UUID AS uuid, ci.summary, ci.description, ci.url, ci.start_date, ci.end_date, ci.all_day,
                c.title AS calendar, l.title AS location, r.frequency, r.interval, r.count, r.end_date AS until
         FROM CalendarItem ci LEFT JOIN Calendar c ON c.ROWID = ci.calendar_id
         LEFT JOIN Location l ON l.ROWID = ci.location_id
         LEFT JOIN Recurrence r ON r.owner_id = ci.ROWID
         WHERE ci.entity_type = 2 AND ci.start_date IS NOT NULL
         ORDER BY ci.start_date`,
      )
      .all() as Row[];
    const byCalendar = new Map<string, CalendarEvent[]>();
    const seen = new Set<number>();
    for (const r of rows) {
      if (seen.has(Number(r.id))) continue; // an event with two recurrence rows keeps the first
      seen.add(Number(r.id));
      const freq = FREQ[Number(r.frequency)] ?? "";
      const until = appleTime(r.until as number);
      const rrule = freq
        ? [`FREQ=${freq}`, `INTERVAL=${Number(r.interval) || 1}`, Number(r.count) ? `COUNT=${Number(r.count)}` : until ? `UNTIL=${until.replace(/[-:]/g, "").replace(/\.\d+/, "")}` : ""].filter(Boolean).join(";")
        : undefined;
      const start = appleTime(r.start_date as number);
      if (!start) continue;
      const calendar = str(r.calendar) || "Calendar";
      byCalendar.set(calendar, [
        ...(byCalendar.get(calendar) ?? []),
        {
          uid: str(r.uuid) || `mobilecareplus-${r.id}`,
          title: str(r.summary) || "Event",
          calendar,
          start,
          end: appleTime(r.end_date as number),
          allDay: Number(r.all_day) === 1,
          location: str(r.location) || undefined,
          notes: str(r.description) || undefined,
          url: str(r.url) || undefined,
          rrule,
        },
      ]);
    }
    return byCalendar;
  });
}

/** Safari bookmarks as a tree (type 1 = folder, 0 = bookmark); the hidden root holds the top level. */
export function listBookmarks(sourceId: string): Promise<{ tree: BookmarkNode[]; count: number }> {
  return withDb(sourceId, "Library/Safari/Bookmarks.db", (db) => {
    const rows = db.prepare("SELECT id, parent, type, title, url FROM bookmarks WHERE COALESCE(hidden, 0) = 0 AND COALESCE(deleted, 0) = 0 ORDER BY order_index").all() as Row[];
    const children = new Map<number, Row[]>();
    for (const r of rows) children.set(Number(r.parent), [...(children.get(Number(r.parent)) ?? []), r]);
    const build = (parent: number, depth: number): BookmarkNode[] =>
      depth > 32
        ? []
        : (children.get(parent) ?? []).map((r) =>
            Number(r.type) === 1 ? { title: str(r.title) || "Folder", children: build(Number(r.id), depth + 1) } : { title: str(r.title), url: str(r.url) },
          );
    const root = rows.find((r) => r.parent === null)?.id ?? 0;
    return { tree: build(Number(root), 0), count: rows.filter((r) => Number(r.type) === 0).length };
  });
}

export interface BackedUpFile {
  domain: string;
  relativePath: string;
  name: string;
  /** Sub-folder to save into (e.g. a conversation title); empty = top level. */
  group: string;
}

const MEDIA = /\.(heic|heif|jpe?g|png|gif|dng|webp|mov|mp4|m4v)$/i;

/** Read-only query against the backup's own index of files (decrypted copy for encrypted backups). */
export async function manifest<T>(sourceId: string, read: (db: DatabaseSync) => T): Promise<T> {
  const db = new DatabaseSync(await manifestDbPath(sourceId), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

export function cameraRollFiles(sourceId: string): Promise<BackedUpFile[]> {
  return manifest(sourceId, (db) =>
    (db.prepare("SELECT relativePath AS path FROM Files WHERE flags = 1 AND domain = 'CameraRollDomain' AND relativePath LIKE 'Media/DCIM/%'").all() as Row[])
      .map((r) => str(r.path))
      .filter((p) => MEDIA.test(p))
      .map((p) => ({ domain: "CameraRollDomain", relativePath: p, name: p.split("/").at(-1)!, group: "" })),
  );
}

/** Message attachments, grouped by conversation title. */
export async function messageAttachments(sourceId: string): Promise<BackedUpFile[]> {
  const titles = new Map((await listConversations(sourceId)).map((c) => [c.id, c.title]));
  return withDb(sourceId, SMS, (db) =>
    (
      db
        .prepare(
          `SELECT DISTINCT cmj.chat_id AS chat, a.filename AS path, a.transfer_name AS name
           FROM attachment a JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
           JOIN chat_message_join cmj ON cmj.message_id = maj.message_id WHERE a.filename IS NOT NULL`,
        )
        .all() as Row[]
    ).map((r) => {
      // Stored as "~/Library/SMS/Attachments/…"; in the backup that's MediaDomain "Library/SMS/Attachments/…".
      const rel = str(r.path).replace(/^~\//, "").replace(/^\/var\/mobile\//, "");
      return { domain: "MediaDomain", relativePath: rel, name: str(r.name) || rel.split("/").at(-1)!, group: titles.get(Number(r.chat)) ?? "Unknown" };
    }),
  );
}

export interface Call {
  date?: string;
  direction: "Outgoing" | "Incoming" | "Missed";
  number: string;
  name?: string;
  seconds: number;
  kind: string;
}

// ZCALLRECORD.ZCALLTYPE: 1 phone, 8 FaceTime video, 16 FaceTime audio.
const CALL_KINDS: Record<number, string> = { 1: "Phone", 8: "FaceTime video", 16: "FaceTime audio" };

/** Call history (only in encrypted backups). */
export async function listCalls(sourceId: string): Promise<Call[]> {
  const book = await nameBook(sourceId);
  return withDb(sourceId, "Library/CallHistoryDB/CallHistory.storedata", (db) =>
    (
      db
        .prepare("SELECT ZADDRESS AS address, ZDATE AS date, ZDURATION AS duration, ZORIGINATED AS out, ZANSWERED AS answered, ZCALLTYPE AS kind FROM ZCALLRECORD ORDER BY ZDATE DESC")
        .all() as Row[]
    ).map((r) => {
      // ZADDRESS is text on most iOS versions and a UTF-8 blob on some.
      const number = r.address instanceof Uint8Array ? Buffer.from(r.address).toString("utf8") : str(r.address);
      return {
        date: appleTime(r.date as number),
        direction: Number(r.out) === 1 ? "Outgoing" : Number(r.answered) === 1 ? "Incoming" : "Missed",
        number,
        name: book.get(handleKey(number)),
        seconds: Math.round(Number(r.duration) || 0),
        kind: CALL_KINDS[Number(r.kind)] ?? "Call",
      };
    }),
  );
}

/** Safari history visits, newest first (only in encrypted backups). */
export function listSafariHistory(sourceId: string): Promise<{ date?: string; title: string; url: string }[]> {
  return withDb(sourceId, "Library/Safari/History.db", (db) =>
    (
      db
        .prepare("SELECT v.visit_time AS time, v.title, i.url FROM history_visits v JOIN history_items i ON i.id = v.history_item ORDER BY v.visit_time DESC")
        .all() as Row[]
    ).map((r) => ({ date: appleTime(r.time as number), title: str(r.title), url: str(r.url) })),
  );
}

// healthdb_secure.sqlite samples.data_type for common quantity types, with the unit Health stores them in.
const HEALTH_TYPES: Record<number, [string, string]> = {
  2: ["Height", "m"],
  3: ["Body mass", "kg"],
  5: ["Heart rate", "count/s"],
  7: ["Steps", "count"],
  8: ["Walking + running distance", "m"],
  9: ["Resting energy", "kcal"],
  10: ["Active energy", "kcal"],
  12: ["Flights climbed", "count"],
};

/**
 * Health samples with a numeric value (only in encrypted backups). Known types get a name and
 * unit; others keep their numeric type so nothing is dropped. ponytail: workouts, sleep and
 * other category samples aren't exported yet.
 */
export function listHealthSamples(sourceId: string): Promise<{ type: string; unit: string; start?: string; end?: string; value: number }[]> {
  return withDb(
    sourceId,
    "Health/healthdb_secure.sqlite",
    (db) =>
      (
        db
          .prepare("SELECT s.data_type AS type, s.start_date AS start, s.end_date AS end, q.quantity AS value FROM samples s JOIN quantity_samples q ON q.data_id = s.data_id WHERE q.quantity IS NOT NULL ORDER BY s.start_date")
          .all() as Row[]
      ).map((r) => {
        const [type, unit] = HEALTH_TYPES[Number(r.type)] ?? [`Type ${r.type}`, ""];
        return { type, unit, start: appleTime(r.start as number), end: appleTime(r.end as number), value: Number(r.value) };
      }),
    "HealthDomain",
  );
}
