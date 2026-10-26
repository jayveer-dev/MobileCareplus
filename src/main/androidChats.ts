// Reading Android WhatsApp chats: decrypt the crypt15 backup with the person's 64-digit key into a
// temporary SQLite file (msgstore.db, cleared on quit like every working copy), then read it.
// The key is used once, in memory. Opened backups are referred to by a random token, so the
// renderer never hands us a file path.
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage, Conversation } from "../shared/types";
import { workDir } from "./backupSource";
import { fileSafe, toConversationHtml } from "./formats";
import { decryptCrypt15, parseBackupKey } from "./crypt15";
import { type AndroidWaApp, pullAndroidBackup } from "./androidWhatsApp";
import { isChatBackup } from "./parse";
import { listSavedWhatsApp } from "./whatsapp";

/** Token → decrypted database, plus the folder holding Media/ when opened from a saved backup. */
const opened = new Map<string, { db: string; root?: string }>();

type Row = Record<string, string | number | bigint | null>;
const str = (v: Row[string] | undefined) => (v === null || v === undefined ? "" : String(v));
const msDate = (v: Row[string] | undefined) => (v ? new Date(Number(v)).toISOString() : undefined);

/** Where to open from: the phone's newest backup (copied first) or a saved Android backup. */
export type AndroidChatSource = { kind: "phone"; deviceId: string } | { kind: "saved"; dir: string };

/** Newest msgstore crypt file in a Databases folder. */
async function newestBackupFile(databases: string): Promise<string> {
  const names = (await readdir(databases).catch(() => [] as string[])).filter(isChatBackup);
  const name = names.find((n) => n.startsWith("msgstore.db.")) ?? names.sort().at(-1);
  if (!name) throw new Error("No WhatsApp chat backup in this folder.");
  return join(databases, name);
}

/** Decrypts with the key and returns a token for chats/messages. Wrong key → WrongKeyError. */
export async function openAndroidChats(appId: AndroidWaApp, source: AndroidChatSource, keyText: string): Promise<string> {
  const key = parseBackupKey(keyText);
  let databases: string;
  if (source.kind === "phone") {
    databases = join(workDir(), "android", source.deviceId, appId);
    await pullAndroidBackup(source.deviceId, appId, databases);
  } else {
    if (!(await listSavedWhatsApp(appId)).some((b) => b.dir === source.dir && b.platform === "android")) throw new Error("Unknown backup");
    databases = join(source.dir, "Databases");
  }
  const plain = decryptCrypt15(await readFile(await newestBackupFile(databases)), key);
  const token = randomUUID();
  const dir = join(workDir(), "android", "open");
  await mkdir(dir, { recursive: true });
  const db = join(dir, `${token}.db`);
  await writeFile(db, plain);
  readChats(db); // fail now, with the reason, if this database version isn't one we read
  opened.set(token, { db, root: source.kind === "saved" ? source.dir : undefined });
  return token;
}

function withDb<T>(token: string, read: (db: DatabaseSync) => T): T {
  const path = opened.get(token)?.db;
  if (!path) throw new Error("Open the backup again with your key.");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

// message.message_type values that aren't plain text.
const TYPE_LABEL: Record<number, string> = {
  1: "Photo",
  2: "Voice message",
  3: "Video",
  4: "Contact card",
  5: "Location",
  9: "Document",
  13: "GIF",
  15: "Deleted message",
  20: "Sticker",
};
// Group events (joins, name changes, security notices): no user content.
const SYSTEM_TYPE = 7;

function readChats(path: string): Conversation[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((r) => str(r.name)));
    // WhatsApp moved to these tables in 2022; older backups use one "messages" table.
    if (!tables.has("message") || !tables.has("chat") || !tables.has("jid"))
      throw new Error("This backup comes from an older WhatsApp version. Update WhatsApp on the phone, make a new backup, and try again.");
    return chatRows(db);
  } finally {
    db.close();
  }
}

function chatRows(db: DatabaseSync): Conversation[] {
  const rows = db
    .prepare(
      `SELECT c._id AS id, c.subject AS subject, j.user AS user, j.server AS server, j.raw_string AS jid,
              (SELECT COUNT(*) FROM message m WHERE m.chat_row_id = c._id AND m.message_type != ${SYSTEM_TYPE}) AS n,
              (SELECT MAX(m.timestamp) FROM message m WHERE m.chat_row_id = c._id) AS last
       FROM chat c JOIN jid j ON j._id = c.jid_row_id
       ORDER BY last DESC`,
    )
    .all() as Row[];
  return rows
    .filter((r) => Number(r.n) > 0)
    .map((r) => {
      const group = str(r.server) === "g.us";
      // The backup has no contact names (those stay in the phone's contacts), so people show as numbers.
      const title = str(r.jid) === "status@broadcast" ? "Status updates" : str(r.subject) || (str(r.user) ? `+${str(r.user)}` : "Chat");
      return { id: Number(r.id), title, participants: [title], messages: Number(r.n), lastDate: msDate(r.last), service: group ? "Group" : "WhatsApp" };
    });
}

export const androidChats = (token: string): Conversation[] => withDb(token, chatRows);

interface AndroidMessage extends ChatMessage {
  /** message_media.file_path: "Media/WhatsApp Images/…" (older phones: a full /storage/… path). */
  media?: string;
}

export function androidMessages(token: string, chatId: number): AndroidMessage[] {
  return withDb(token, (db) => {
    const rows = db
      .prepare(
        `SELECT m._id AS id, m.from_me AS me, m.timestamp AS ts, m.message_type AS type, m.text_data AS text,
                s.user AS sender, mm.file_path AS media, mm.media_caption AS caption
         FROM message m
         LEFT JOIN jid s ON s._id = m.sender_jid_row_id
         LEFT JOIN message_media mm ON mm.message_row_id = m._id
         WHERE m.chat_row_id = ? AND m.message_type != ${SYSTEM_TYPE}
         ORDER BY m.timestamp, m._id`,
      )
      .all(chatId) as Row[];
    return rows.map((r) => {
      const fromMe = Number(r.me) === 1;
      const media = str(r.media);
      const label = TYPE_LABEL[Number(r.type)];
      const text = str(r.text) || str(r.caption);
      return {
        id: Number(r.id),
        date: msDate(r.ts),
        fromMe,
        sender: fromMe ? undefined : str(r.sender) ? `+${str(r.sender)}` : undefined,
        text: text || (label && !media ? label : ""),
        attachments: media ? [media.split("/").at(-1)!] : label && !text ? [label] : [],
        media: media || undefined,
      };
    });
  });
}

/**
 * Export: one web page per chat. Media files are copied too when the backup was saved with its
 * Media folder; opened straight from the phone, only the pages are written.
 */
export async function exportAndroidChats(token: string, dest: string, signal: AbortSignal, onChat: (done: number, total: number) => void) {
  const root = opened.get(token)?.root;
  const chats = androidChats(token);
  await mkdir(dest, { recursive: true });
  const taken = new Set<string>();
  for (const [i, c] of chats.entries()) {
    if (signal.aborted) break;
    let name = fileSafe(c.title, "Chat");
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${fileSafe(c.title, "Chat")} (${n})`;
    taken.add(name.toLowerCase());
    const messages = androidMessages(token, c.id);
    await writeFile(join(dest, `${name}.html`), toConversationHtml(c.title, messages));
    if (root) {
      for (const m of messages) {
        const rel = m.media?.slice(Math.max(0, m.media.indexOf("Media/")));
        if (!rel?.startsWith("Media/")) continue;
        await mkdir(join(dest, "Media", name), { recursive: true });
        await copyFile(join(root, ...rel.split("/")), join(dest, "Media", name, fileSafe(rel.split("/").at(-1)!, "media"))).catch(() => {});
      }
    }
    onChat(i + 1, chats.length);
  }
  return dest;
}
