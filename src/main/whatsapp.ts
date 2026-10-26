// WhatsApp and WhatsApp Business on iPhone: chats, messages and media from ChatStorage.sqlite in
// the app's shared container. Reads either the personal-data cache (a backup folder, possibly
// encrypted) or a saved WhatsApp backup (a plain folder made by saveWhatsAppBackup).
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage, Conversation } from "../shared/types";
import { manifest, withDb } from "./backupData";
import { storageRoot } from "./backups";
import { extractFile } from "./backupSource";
import { fileSafe, toConversationHtml } from "./formats";
import { appleTime } from "./parse";

export type WaApp = "whatsapp" | "business";
/** Every WhatsApp variant with saved backups; GBWhatsApp exists on Android only. */
export type ChatApp = WaApp | "gbwhatsapp";

/** Backup domain of each app's shared container (its group id with AppDomainGroup- in front). */
const DOMAIN: Record<WaApp, string> = {
  whatsapp: "AppDomainGroup-group.net.whatsapp.WhatsApp.shared",
  business: "AppDomainGroup-group.net.whatsapp.WhatsAppSMB.shared",
};
const DB = "ChatStorage.sqlite";
// ZWAMEDIAITEM.ZMEDIALOCALPATH is relative to the container's Message/ folder.
const MEDIA_BASE = "Message/";

/** Where WhatsApp data is read from. */
export type WaSource = { kind: "loaded"; sourceId: string } | { kind: "saved"; dir: string };

// ZWAMESSAGE.ZMESSAGETYPE values that aren't plain text.
const TYPE_LABEL: Record<number, string> = {
  1: "Photo",
  2: "Video",
  3: "Voice message",
  4: "Contact card",
  5: "Location",
  7: "Link",
  8: "Document",
  11: "GIF",
  15: "Sticker",
};
// Group events (joins, name changes) and similar: no user content.
const SYSTEM_TYPES = new Set([6, 10]);

type Row = Record<string, string | number | null>;
const str = (v: Row[string] | undefined) => (v === null || v === undefined ? "" : String(v));

async function openWa<T>(source: WaSource, appId: WaApp, read: (db: DatabaseSync) => T): Promise<T> {
  if (source.kind === "loaded") return withDb(source.sourceId, DB, read, DOMAIN[appId]);
  const db = new DatabaseSync(join(source.dir, DB), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** Columns differ between WhatsApp versions; only use ones that exist. */
const columns = (db: DatabaseSync, table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name)));

export function waChats(source: WaSource, appId: WaApp): Promise<Conversation[]> {
  return openWa(source, appId, (db) => {
    const cols = columns(db, "ZWACHATSESSION");
    const removed = cols.has("ZREMOVED") ? "AND COALESCE(s.ZREMOVED, 0) = 0" : "";
    const rows = db
      .prepare(
        `SELECT s.Z_PK AS id, s.ZPARTNERNAME AS name, s.ZCONTACTJID AS jid, s.ZLASTMESSAGEDATE AS last,
                (SELECT COUNT(*) FROM ZWAMESSAGE m WHERE m.ZCHATSESSION = s.Z_PK) AS n
         FROM ZWACHATSESSION s WHERE 1 = 1 ${removed} ORDER BY s.ZLASTMESSAGEDATE DESC`,
      )
      .all() as Row[];
    return rows
      .filter((r) => Number(r.n) > 0)
      .map((r) => {
        const jid = str(r.jid);
        // Status updates live in a pseudo-chat named status@broadcast.
        const title = jid === "status@broadcast" ? "Status updates" : str(r.name) || jid.split("@")[0] || "Chat";
        return {
          id: Number(r.id),
          title,
          participants: [title],
          messages: Number(r.n),
          lastDate: appleTime(r.last as number),
          service: jid.endsWith("@g.us") ? "Group" : "WhatsApp",
        };
      });
  });
}

export interface WaMessage extends ChatMessage {
  /** Path of the media file inside the container, for export. */
  media?: string;
}

export function waMessages(source: WaSource, appId: WaApp, chatId: number): Promise<WaMessage[]> {
  return openWa(source, appId, (db) => {
    const hasMembers = columns(db, "ZWAMESSAGE").has("ZGROUPMEMBER");
    const rows = db
      .prepare(
        `SELECT m.Z_PK AS id, m.ZISFROMME AS me, m.ZMESSAGEDATE AS date, m.ZTEXT AS text, m.ZMESSAGETYPE AS type,
                m.ZFROMJID AS fromJid, ${hasMembers ? "g.ZCONTACTNAME" : "NULL"} AS member,
                i.ZMEDIALOCALPATH AS media, i.ZTITLE AS mediaTitle
         FROM ZWAMESSAGE m
         ${hasMembers ? "LEFT JOIN ZWAGROUPMEMBER g ON g.Z_PK = m.ZGROUPMEMBER" : ""}
         LEFT JOIN ZWAMEDIAITEM i ON i.Z_PK = m.ZMEDIAITEM
         WHERE m.ZCHATSESSION = ? ORDER BY m.ZMESSAGEDATE, m.Z_PK`,
      )
      .all(chatId) as Row[];
    return rows
      .filter((r) => !SYSTEM_TYPES.has(Number(r.type)))
      .map((r) => {
        const fromMe = Number(r.me) === 1;
        const media = str(r.media) || undefined;
        const label = TYPE_LABEL[Number(r.type)];
        const caption = str(r.text) || str(r.mediaTitle);
        return {
          id: Number(r.id),
          date: appleTime(r.date as number),
          fromMe,
          sender: fromMe ? undefined : str(r.member) || str(r.fromJid).split("@")[0] || undefined,
          text: caption || (label && !media ? label : ""),
          attachments: media ? [media.split("/").at(-1)!] : label && Number(r.type) !== 7 && !caption ? [label] : [],
          media,
        };
      });
  });
}

/** Copies one chat's media from the source into dir; returns how many files were copied. */
async function copyMedia(source: WaSource, appId: WaApp, messages: WaMessage[], dir: string): Promise<number> {
  let copied = 0;
  for (const m of messages) {
    if (!m.media) continue;
    const name = fileSafe(m.media.split("/").at(-1)!, "media");
    await mkdir(dir, { recursive: true });
    const ok =
      source.kind === "loaded"
        ? await extractFile(source.sourceId, DOMAIN[appId], MEDIA_BASE + m.media, join(dir, name))
        : await copyFile(join(source.dir, MEDIA_BASE, m.media), join(dir, name)).then(() => true, () => false);
    if (ok) copied++;
  }
  return copied;
}

/** Export: one web page per chat, media in a folder per chat. Returns counts for the summary. */
export async function exportWhatsApp(source: WaSource, appId: WaApp, dest: string, signal: AbortSignal, onChat: (done: number, total: number) => void) {
  const chats = await waChats(source, appId);
  await mkdir(dest, { recursive: true });
  let media = 0;
  const taken = new Set<string>();
  for (const [i, c] of chats.entries()) {
    if (signal.aborted) break;
    let name = fileSafe(c.title, "Chat");
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${fileSafe(c.title, "Chat")} (${n})`;
    taken.add(name.toLowerCase());
    const messages = await waMessages(source, appId, c.id);
    await writeFile(join(dest, `${name}.html`), toConversationHtml(c.title, messages));
    media += await copyMedia(source, appId, messages, join(dest, "Media", name));
    onChat(i + 1, chats.length);
  }
  return { chats: chats.length, media };
}

// ---- Saved WhatsApp backups: a plain folder with the database and media, plus a small info file.

export const savedRoot = (appId: ChatApp) => join(storageRoot(), "WhatsApp Backups", appId);

export interface SavedWaBackup {
  dir: string;
  date: string;
  deviceName: string;
  platform: "ios" | "android";
  /** Unknown for Android backups until they're read with the 64-digit key. */
  chats?: number;
  bytes: number;
}

/**
 * Back up: copies the app's database and every media file it references out of the loaded data
 * (decrypting when needed) into a dated folder, so it stays viewable after later loads.
 */
export async function saveWhatsAppBackup(sourceId: string, appId: WaApp, deviceName: string, signal: AbortSignal, onFile: (done: number, total: number) => void): Promise<string> {
  const loaded: WaSource = { kind: "loaded", sourceId };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(savedRoot(appId), stamp);
  await mkdir(dir, { recursive: true });
  // Database plus its journal (recent messages may still be there).
  for (const name of [DB, `${DB}-wal`]) await extractFile(sourceId, DOMAIN[appId], name, join(dir, name));
  const files = await manifest(sourceId, (db) =>
    (db.prepare("SELECT relativePath FROM Files WHERE domain = ? AND flags = 1 AND relativePath LIKE ?").all(DOMAIN[appId], `${MEDIA_BASE}%`) as Row[]).map((r) => str(r.relativePath)),
  );
  for (const [i, rel] of files.entries()) {
    if (signal.aborted) break;
    const target = join(dir, ...rel.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await extractFile(sourceId, DOMAIN[appId], rel, target);
    onFile(i + 1, files.length);
  }
  const chats = (await waChats({ kind: "saved", dir }, appId)).length;
  await writeFile(join(dir, "backup.json"), JSON.stringify({ date: new Date().toISOString(), deviceName, chats }, null, 2));
  return dir;
}

async function folderSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) total += (await stat(join(e.parentPath, e.name))).size;
  return total;
}

export async function listSavedWhatsApp(appId: ChatApp): Promise<SavedWaBackup[]> {
  const root = savedRoot(appId);
  const names = await readdir(root).catch(() => [] as string[]);
  const out: SavedWaBackup[] = [];
  for (const name of names) {
    const dir = join(root, name);
    const info = await readFile(join(dir, "backup.json"), "utf8").then((t) => JSON.parse(t) as { date: string; deviceName: string; chats?: number; platform?: "android" }, () => undefined);
    if (info) out.push({ dir, date: info.date, deviceName: info.deviceName, platform: info.platform ?? "ios", chats: info.chats, bytes: await folderSize(dir) });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** Whether the loaded data contains this app's database at all (app not installed = no). */
export async function hasLoadedWhatsApp(sourceId: string, appId: WaApp): Promise<boolean> {
  return manifest(sourceId, (db) => !!db.prepare("SELECT 1 FROM Files WHERE domain = ? AND relativePath = ?").get(DOMAIN[appId], DB));
}
