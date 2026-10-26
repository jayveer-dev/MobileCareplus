// Contacts and calendar on an Android phone, read from its own providers over adb (read-only).
import type { Contact } from "../shared/types";
import type { CalendarEvent } from "./formats";
import { parseContentRows } from "./parse";
import { run } from "./tools";

const CONTACTS = "content://com.android.contacts";
const CALENDAR = "content://com.android.calendar";

const query = async (id: string, uri: string, columns: string[], where?: string) => {
  const args = ["-s", id, "shell", "content", "query", "--uri", uri, "--projection", columns.join(":")];
  if (where) args.push("--where", `"${where}"`);
  return parseContentRows(await run("adb", args, { timeoutMs: 120_000 }), columns);
};

// ContactsContract common data kinds.
const MIME = { name: "vnd.android.cursor.item/name", phone: "vnd.android.cursor.item/phone_v2", email: "vnd.android.cursor.item/email_v2", org: "vnd.android.cursor.item/organization" };
const PHONE_LABEL: Record<string, string> = { 1: "home", 2: "mobile", 3: "work", 4: "work fax", 5: "home fax", 6: "pager", 7: "other", 12: "main" };
const EMAIL_LABEL: Record<string, string> = { 1: "home", 2: "work", 3: "other", 4: "mobile" };

export async function androidContacts(id: string): Promise<Contact[]> {
  const people = new Map<number, Contact>();
  for (const r of await query(id, `${CONTACTS}/contacts`, ["_id", "display_name"])) {
    const cid = Number(r._id);
    if (cid) people.set(cid, { id: cid, name: r.display_name ?? "", phones: [], emails: [] });
  }
  const rows = await query(id, `${CONTACTS}/data`, ["contact_id", "mimetype", "data1", "data2"], `mimetype IN ('${MIME.phone}','${MIME.email}','${MIME.org}')`);
  for (const r of rows) {
    const c = people.get(Number(r.contact_id));
    if (!c || !r.data1) continue;
    if (r.mimetype === MIME.phone) c.phones.push({ label: PHONE_LABEL[r.data2 ?? ""] ?? "other", value: r.data1 });
    else if (r.mimetype === MIME.email) c.emails.push({ label: EMAIL_LABEL[r.data2 ?? ""] ?? "other", value: r.data1 });
    else if (!c.organization) c.organization = r.data1;
  }
  // Phone-number-only entries with no name show the number, as the phone's own Contacts app does.
  return [...people.values()].map((c) => ({ ...c, name: c.name || c.phones[0]?.value || "No name" })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Events by calendar name, like the iPhone reader; the phone's own holiday feeds come along too. */
export async function androidCalendars(id: string): Promise<Map<string, CalendarEvent[]>> {
  const names = new Map((await query(id, `${CALENDAR}/calendars`, ["_id", "calendar_displayName"])).map((r) => [r._id ?? "", r.calendar_displayName ?? "Calendar"]));
  const rows = await query(id, `${CALENDAR}/events`, ["_id", "calendar_id", "title", "dtstart", "dtend", "duration", "allDay", "rrule", "eventLocation", "description"], "deleted=0");
  const out = new Map<string, CalendarEvent[]>();
  for (const r of rows) {
    const start = Number(r.dtstart);
    if (!start) continue;
    const calendar = names.get(r.calendar_id ?? "") ?? "Calendar";
    const event: CalendarEvent = {
      uid: `android-${r._id}@mobilecareplus`,
      title: r.title ?? "Untitled",
      calendar,
      start: new Date(start).toISOString(),
      // Recurring events carry a duration (RFC 2445, e.g. P1D) instead of an end; the writer treats no-end as point/all-day.
      end: Number(r.dtend) ? new Date(Number(r.dtend)).toISOString() : undefined,
      allDay: r.allDay === "1",
      location: r.eventLocation || undefined,
      notes: r.description || undefined,
      rrule: r.rrule || undefined,
    };
    out.set(calendar, [...(out.get(calendar) ?? []), event]);
  }
  return out;
}
