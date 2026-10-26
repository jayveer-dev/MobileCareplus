// Export file formats. Pure functions (no Electron) so `node --test` covers them.
import type { ChatMessage, Contact } from "../shared/types";

/** vCard 3.0 text escaping (RFC 2426): backslash, comma, semicolon, newline. */
const vcardText = (s: string) => s.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\r?\n/g, "\\n");
const vcardType = (label: string) => label.toUpperCase().replace(/[^A-Z0-9-]/g, "") || "OTHER";

export function toVcard(contacts: Contact[]): string {
  return contacts
    .map((c) => {
      const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${vcardText(c.name)}`];
      if (c.organization) lines.push(`ORG:${vcardText(c.organization)}`);
      for (const p of c.phones) lines.push(`TEL;TYPE=${vcardType(p.label)}:${vcardText(p.value)}`);
      for (const e of c.emails) lines.push(`EMAIL;TYPE=${vcardType(e.label)}:${vcardText(e.value)}`);
      lines.push("END:VCARD");
      return lines.join("\r\n");
    })
    .join("\r\n")
    .concat("\r\n");
}

/** RFC 4180 field: quoted when it holds a comma, quote or newline; a leading =+-@ is prefixed so spreadsheets don't run it as a formula. */
export function csvField(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV with a BOM, so Excel opens UTF-8 names correctly. */
export const toCsv = (header: string[], rows: string[][]) => `\uFEFF${[header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n")}\r\n`;

export const toContactsCsv = (contacts: Contact[]) =>
  toCsv(
    ["Name", "Organization", "Phones", "Emails"],
    contacts.map((c) => [c.name, c.organization ?? "", c.phones.map((p) => `${p.label}: ${p.value}`).join("; "), c.emails.map((e) => `${e.label}: ${e.value}`).join("; ")]),
  );

export interface CalendarEvent {
  uid: string;
  title: string;
  calendar: string;
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  url?: string;
  /** RRULE value, e.g. "FREQ=YEARLY;INTERVAL=1". */
  rrule?: string;
}

/** iCalendar text escaping (RFC 5545 §3.3.11) and 75-octet line folding (§3.1). */
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (start === 0 ? 75 : 74), bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // don't split a UTF-8 character
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return parts.join("\r\n ");
}
const icsUtc = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d+/, "");
const icsDate = (iso: string) => iso.slice(0, 10).replace(/-/g, "");

export function toIcs(calendarName: string, events: CalendarEvent[]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mobile Care Plus//Calendar export//EN", `X-WR-CALNAME:${icsText(calendarName)}`];
  const stamp = icsUtc(new Date().toISOString());
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${icsText(e.uid)}`, `DTSTAMP:${stamp}`, `SUMMARY:${icsText(e.title)}`);
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(e.start)}`);
      if (e.end) lines.push(`DTEND;VALUE=DATE:${icsDate(e.end)}`);
    } else {
      lines.push(`DTSTART:${icsUtc(e.start)}`);
      if (e.end) lines.push(`DTEND:${icsUtc(e.end)}`);
    }
    if (e.rrule) lines.push(`RRULE:${e.rrule}`);
    if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
    if (e.notes) lines.push(`DESCRIPTION:${icsText(e.notes)}`);
    if (e.url) lines.push(`URL:${e.url.replace(/[\r\n]/g, "")}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

export interface BookmarkNode {
  title: string;
  url?: string;
  children?: BookmarkNode[];
}

/** Netscape bookmark file: the format every browser's "Import bookmarks" accepts. */
export function toBookmarksHtml(nodes: BookmarkNode[]): string {
  const render = (list: BookmarkNode[], depth: number): string => {
    const pad = "    ".repeat(depth);
    return list
      .map((n) =>
        n.children
          ? `${pad}<DT><H3>${html(n.title)}</H3>\n${pad}<DL><p>\n${render(n.children, depth + 1)}${pad}</DL><p>\n`
          : `${pad}<DT><A HREF="${html(n.url ?? "")}">${html(n.title || n.url || "")}</A>\n`,
      )
      .join("");
  };
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${render(nodes, 1)}</DL><p>\n`;
}

/** Safe file or folder name on macOS and Windows. */
export const fileSafe = (s: string, fallback = "Untitled") =>
  s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 80) || fallback;

const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A self-contained, readable page for one conversation. */
export function toConversationHtml(title: string, messages: ChatMessage[]): string {
  const body = messages
    .map((m) => {
      const when = m.date ? new Date(m.date).toLocaleString() : "";
      const who = m.fromMe ? "Me" : (m.sender ?? "");
      const files = m.attachments.length ? `<div class="files">${m.attachments.map((a) => `📎 ${html(a)}`).join("<br>")}</div>` : "";
      return `<div class="msg ${m.fromMe ? "me" : "them"}"><div class="meta">${html(who)} · ${html(when)}</div>${m.text ? `<div class="text">${html(m.text)}</div>` : ""}${files}</div>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${html(title)}</title>
<style>
body{font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:720px;margin:32px auto;padding:0 16px;background:#eef1f4;color:#16202b}
h1{font-size:22px}.msg{margin:10px 0;max-width:78%;padding:8px 12px;border-radius:14px;background:#fff}
.msg.me{margin-left:auto;background:#2b4fd8;color:#fff}.meta{font-size:12px;opacity:.7;margin-bottom:2px}
.text{white-space:pre-wrap;overflow-wrap:anywhere}.files{font-size:13px;margin-top:4px;opacity:.85}
</style></head><body><h1>${html(title)}</h1><p>${messages.length} messages, exported by Mobile Care Plus.</p>
${body}
</body></html>
`;
}
