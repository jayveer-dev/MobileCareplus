import { strict as assert } from "node:assert";
import { test } from "node:test";
import { csvField, toContactsCsv, toConversationHtml, toVcard } from "./formats.ts";
import { appleTime, attributedBodyText, contactLabel, handleKey } from "./parse.ts";

const person = { id: 1, name: "Alex, Morgan", organization: "Acme; Inc", phones: [{ label: "Mobile", value: "+1 202 555 0143" }], emails: [{ label: "Home", value: "j@x.com" }] };

test("vCard escapes and lists every value", () => {
  assert.equal(
    toVcard([person]),
    "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alex\\, Morgan\r\nORG:Acme\\; Inc\r\nTEL;TYPE=MOBILE:+1 202 555 0143\r\nEMAIL;TYPE=HOME:j@x.com\r\nEND:VCARD\r\n",
  );
});

test("CSV quotes and defuses formulas", () => {
  assert.equal(csvField('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvField("=SUM(A1)"), "'=SUM(A1)");
  assert.ok(toContactsCsv([person]).startsWith("﻿Name,Organization,Phones,Emails\r\n\"Alex, Morgan\",Acme; Inc,Mobile: +1 202 555 0143,Home: j@x.com"));
});

test("conversation HTML escapes message text", () => {
  const page = toConversationHtml("<Bob>", [{ id: 1, fromMe: false, sender: "Bob", text: "<script>x</script>", attachments: ["a.jpg"], date: "2026-10-23T10:00:00.000Z" }]);
  assert.ok(page.includes("&lt;script&gt;x&lt;/script&gt;") && !page.includes("<script>x"));
  assert.ok(page.includes("<title>&lt;Bob&gt;</title>"));
});

test("message helpers", () => {
  assert.equal(appleTime(0), undefined);
  assert.equal(appleTime(783_000_000), "2025-10-24T12:00:00.000Z"); // seconds
  assert.equal(appleTime(783_000_000_000_000_000n), "2025-10-24T12:00:00.000Z"); // nanoseconds
  // typedstream: ...NSString 01 94 84 01 2B <len> <utf8>
  const text = "Hello 👋";
  const body = Buffer.concat([Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01", "latin1"), Buffer.from([0x2b, Buffer.byteLength(text)]), Buffer.from(text)]);
  assert.equal(attributedBodyText(body), text);
  const long = "x".repeat(300);
  const longBody = Buffer.concat([Buffer.from("NSString\x01\x94\x84\x01+", "latin1"), Buffer.from([0x81, 300 & 0xff, 300 >> 8]), Buffer.from(long)]);
  assert.equal(attributedBodyText(longBody), long);
  assert.equal(attributedBodyText(null), undefined);
  assert.equal(contactLabel("_$!<Mobile>!$_"), "Mobile");
  assert.equal(contactLabel("Work cell"), "Work cell");
  assert.equal(handleKey("+1 202 555 0143"), handleKey("2025550143"));
  assert.equal(handleKey("Alex@X.com"), "alex@x.com");
});

test("ics: escaping, all-day dates, recurrence, folding", async () => {
  const { toIcs } = await import("./formats.ts");
  const ics = toIcs("Home", [
    { uid: "u1", title: "Mum's birthday; party, cake", calendar: "Home", start: "2026-03-04T00:00:00.000Z", end: "2026-03-05T00:00:00.000Z", allDay: true, rrule: "FREQ=YEARLY;INTERVAL=1" },
    { uid: "u2", title: "x".repeat(100), calendar: "Home", start: "2026-03-04T09:30:00.000Z", allDay: false },
  ]);
  assert.ok(ics.includes("SUMMARY:Mum's birthday\\; party\\, cake\r\n"));
  assert.ok(ics.includes("DTSTART;VALUE=DATE:20260304\r\nDTEND;VALUE=DATE:20260305\r\nRRULE:FREQ=YEARLY;INTERVAL=1\r\n"));
  assert.ok(ics.includes("DTSTART:20260304T093000Z\r\n"));
  assert.ok(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75), "lines folded to 75 octets");
  assert.ok(ics.includes("\r\n x"), "continuation lines start with a space");
});

test("bookmarks file nests folders and escapes", async () => {
  const { toBookmarksHtml } = await import("./formats.ts");
  const out = toBookmarksHtml([{ title: "Work", children: [{ title: "A&B", url: "https://x.com/?a=1&b=2" }] }]);
  assert.ok(out.startsWith("<!DOCTYPE NETSCAPE-Bookmark-file-1>"));
  assert.ok(out.includes('<DT><H3>Work</H3>\n    <DL><p>\n        <DT><A HREF="https://x.com/?a=1&amp;b=2">A&amp;B</A>'));
});

test("fileSafe", async () => {
  const { fileSafe } = await import("./formats.ts");
  assert.equal(fileSafe('a/b:c*?"<>|'), "a_b_c______");
  assert.equal(fileSafe("..."), "Untitled");
  assert.equal(fileSafe(" .hidden. "), "hidden");
});

test("notes protobuf text", async () => {
  const { noteText, protoFields } = await import("./parse.ts");
  const { gzipSync, gunzipSync } = await import("node:zlib");
  const lenField = (field: number, payload: Buffer) => Buffer.concat([Buffer.from([(field << 3) | 2, payload.length]), payload]);
  const text = Buffer.from("Shopping\nMilk ￼");
  const store = lenField(2, Buffer.concat([Buffer.from([0x08, 0x00]), lenField(3, Buffer.concat([lenField(2, text), Buffer.from([0x18, 0x96, 0x01])]))]));
  assert.equal(noteText(gzipSync(store), gunzipSync), "Shopping\nMilk ");
  assert.equal(noteText(Buffer.from("not gzip"), gunzipSync), undefined);
  assert.deepEqual(protoFields(Buffer.from([0x18, 0x96, 0x01])), [[3, 150]]);
});
