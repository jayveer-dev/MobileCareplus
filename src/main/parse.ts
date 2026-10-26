// Pure parsers for device-tool output. No imports so `node --test` runs them directly.

/** `ideviceinfo` prints `Key: Value` lines; nested dicts are indented and skipped. */
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s/.test(line)) continue;
    const i = line.indexOf(": ");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 2).trim();
  }
  return out;
}

export interface AdbEntry {
  serial: string;
  state: string;
  model?: string;
}

/** `adb devices -l`: `<serial> <state> key:value ...` after a header line. */
export function parseAdbDevices(text: string): AdbEntry[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("List of devices") && !l.startsWith("*"))
    .map((l) => {
      const [serial, state, ...rest] = l.trim().split(/\s+/);
      const model = rest.find((p) => p.startsWith("model:"))?.slice(6).replace(/_/g, " ");
      return { serial, state, model };
    });
}

/** `getprop` prints `[key]: [value]` lines. */
export function parseGetprop(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^\[([^\]]+)\]: \[(.*)\]\s*$/gm)) out[m[1]] = m[2];
  return out;
}

/** Last `NN%` in a chunk of tool output (idevicebackup2 redraws its bar with \r). */
export function lastPercent(chunk: string): number | undefined {
  const all = [...chunk.matchAll(/(\d{1,3}(?:\.\d+)?)%/g)];
  const n = all.length ? Number(all[all.length - 1][1]) : NaN;
  return n >= 0 && n <= 100 ? n : undefined;
}

/**
 * Whole-backup percent from idevicebackup2, ignoring its per-file bars.
 * 1.4.0 prints `] 45% Finished` (overall) and `] 100% (12 MB/12 MB)` (file);
 * later versions label the overall line `Backup [bar] 45%`.
 */
export function backupPercent(chunk: string): number | undefined {
  const hits = [...chunk.matchAll(/(\d{1,3}(?:\.\d+)?)%\s+Finished|^Backup\s.*?\s(\d{1,3}(?:\.\d+)?)%/gm)];
  const last = hits.at(-1);
  const n = last ? Number(last[1] ?? last[2]) : NaN;
  return n >= 0 && n <= 100 ? n : undefined;
}

/** `df -k /data` on Android: second line is `<fs> <1K-blocks> <used> <available> ...`. */
export function parseDfKilobytes(text: string): { total: number; used: number; free: number } | undefined {
  const cols = text.trim().split(/\r?\n/)[1]?.trim().split(/\s+/);
  if (!cols || cols.length < 4) return undefined;
  const [total, used, free] = cols.slice(1, 4).map((n) => Number(n) * 1024);
  return [total, used, free].every(Number.isFinite) ? { total, used, free } : undefined;
}

export interface AfcEntry {
  name: string;
  size: number;
  /** ISO 8601, local time as the phone reports it. */
  date: string;
  isDir: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `afcclient -- ls -l DIR`: `-rw-r--r--  1 mobile mobile  2439012 04 Oct 2026 09:32:40 IMG_0012.HEIC`. */
export function parseAfcLongList(text: string): AfcEntry[] {
  const out: AfcEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([d-])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{2}) (\w{3}) (\d{4}) (\d{2}:\d{2}:\d{2}) (.+)$/);
    if (!m) continue;
    const month = String(MONTHS.indexOf(m[4]) + 1).padStart(2, "0");
    out.push({ isDir: m[1] === "d", size: Number(m[2]), date: `${m[5]}-${month}-${m[3]}T${m[6]}`, name: m[7] });
  }
  return out;
}

/** Android `ls -l DIR` (toybox): `-rw-rw---- 1 u0_a123 media_rw 5242880 2026-10-20 02:00 msgstore.db.crypt15`. */
export function parseAndroidLongList(text: string): AfcEntry[] {
  const out: AfcEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([d-])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (.+)$/);
    if (m) out.push({ isDir: m[1] === "d", size: Number(m[2]), date: `${m[3]}T${m[4]}:00`, name: m[5] });
  }
  return out;
}

/**
 * `adb shell content query --projection a:b:c` rows: `Row: 0 a=1, b=x, y, c=NULL`. Values may contain
 * ", ", so each value runs to the next known column name. NULL becomes undefined.
 */
export function parseContentRows(text: string, columns: string[]): Record<string, string | undefined>[] {
  const out: Record<string, string | undefined>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^Row: \d+ (.*)$/);
    if (!m) continue;
    const row: Record<string, string | undefined> = {};
    let rest = m[1];
    for (const [i, col] of columns.entries()) {
      if (!rest.startsWith(`${col}=`)) break;
      rest = rest.slice(col.length + 1);
      const next = columns[i + 1];
      const end = next ? rest.indexOf(`, ${next}=`) : -1;
      const value = end >= 0 ? rest.slice(0, end) : rest;
      row[col] = value === "NULL" ? undefined : value;
      rest = end >= 0 ? rest.slice(end + 2) : "";
    }
    out.push(row);
  }
  return out;
}

/**
 * A full chat backup: msgstore.db.cryptNN (newest) or msgstore-YYYY-MM-DD.1.db.cryptNN (older).
 * msgstore-increment-… files only hold changes since a full one, so they don't count.
 */
export const isChatBackup = (name: string) => /^msgstore(-\d{4}-\d{2}-\d{2}\.\d+)?\.db\.crypt\d+$/.test(name);

/** iOS stores times as seconds (older) or nanoseconds (newer) since 2001-01-01 UTC. */
export function appleTime(value: number | bigint | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  if (!n) return undefined;
  const seconds = n > 1e12 ? n / 1e9 : n;
  return new Date((seconds + 978_307_200) * 1000).toISOString();
}

/**
 * Plain text of an iMessage `attributedBody` (an NSAttributedString in Apple's typedstream
 * format), which newer iOS versions fill instead of `text`. The string follows the first
 * "NSString" class name: a `+` marker, then a length (1 byte, or 0x81 + uint16 LE, or 0x82 + uint32 LE).
 */
export function attributedBodyText(blob: Uint8Array | null | undefined): string | undefined {
  if (!blob) return undefined;
  const buf = Buffer.from(blob);
  const at = buf.indexOf("NSString");
  if (at < 0) return undefined;
  const plus = buf.indexOf(0x2b, at + 8);
  if (plus < 0 || plus > at + 16) return undefined;
  let pos = plus + 1;
  let len = buf[pos++];
  if (len === 0x81) {
    len = buf.readUInt16LE(pos);
    pos += 2;
  } else if (len === 0x82) {
    len = buf.readUInt32LE(pos);
    pos += 4;
  }
  if (pos + len > buf.length) return undefined;
  return buf.subarray(pos, pos + len).toString("utf8");
}

type ProtoField = [field: number, value: number | Buffer];

/** Top-level fields of a protobuf message (varint and length-delimited; fixed-width skipped). */
export function protoFields(buf: Buffer): ProtoField[] {
  const out: ProtoField[] = [];
  let i = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (i >= buf.length) throw new Error("Truncated protobuf");
      byte = buf[i++];
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const type = key & 7;
    if (type === 0) out.push([field, varint()]);
    else if (type === 2) {
      const len = varint();
      out.push([field, buf.subarray(i, i + len)]);
      i += len;
    } else if (type === 1) i += 8;
    else if (type === 5) i += 4;
    else throw new Error(`Unsupported protobuf wire type ${type}`);
  }
  return out;
}

/** Apple Notes body: gzip-compressed protobuf, text at NoteStoreProto.document(2).note(3).note_text(2). */
export function noteText(gzipped: Uint8Array, gunzip: (b: Buffer) => Buffer): string | undefined {
  try {
    let msg = gunzip(Buffer.from(gzipped));
    for (const field of [2, 3]) {
      const next = protoFields(msg).find(([f, v]) => f === field && Buffer.isBuffer(v))?.[1];
      if (!Buffer.isBuffer(next)) return undefined;
      msg = next;
    }
    const text = protoFields(msg).find(([f, v]) => f === 2 && Buffer.isBuffer(v))?.[1];
    // U+FFFC marks embedded objects (images, tables) that aren't plain text.
    return Buffer.isBuffer(text) ? text.toString("utf8").replace(/￼/g, "") : undefined;
  } catch {
    return undefined;
  }
}

/** "_$!<Mobile>!$_" → "Mobile"; custom labels pass through. */
export const contactLabel = (label: string | null | undefined) => (label ?? "").replace(/^_\$!<(.*)>!\$_$/, "$1") || "Other";

/** Last 10 digits, so +1 202 555 0143 and 2025550143 match. Emails compare lowercased. */
export const handleKey = (handle: string) => (handle.includes("@") ? handle.trim().toLowerCase() : handle.replace(/\D/g, "").slice(-10));

const SIZE_UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** Current part of the transfer from idevicebackup2's `(12.0 MB/48.3 MB)`, in bytes. */
export function transferBytes(chunk: string): { current: number; total: number } | undefined {
  const all = [...chunk.matchAll(/\(([\d.]+) (B|KB|MB|GB|TB)\/([\d.]+) (B|KB|MB|GB|TB)\)/g)];
  const m = all.at(-1);
  if (!m) return undefined;
  return { current: Number(m[1]) * SIZE_UNITS[m[2]], total: Number(m[3]) * SIZE_UNITS[m[4]] };
}

/** Status lines worth rewording for people. */
const FRIENDLY_STATUS: [RegExp, string][] = [[/waiting for passcode/i, "Enter your passcode on the iPhone to allow this"]];

/** Last plain status line ("Receiving files", "Incremental backup mode."), skipping progress bars. */
export function statusLine(chunk: string): string | undefined {
  const line = rawStatusLine(chunk);
  return line && (FRIENDLY_STATUS.find(([re]) => re.test(line))?.[1] ?? line);
}

function rawStatusLine(chunk: string): string | undefined {
  return chunk
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !l.includes("%") && !l.startsWith("[") && l.length < 120)
    .at(-1);
}

const DOMAIN_CATEGORIES: [RegExp, string][] = [
  [/^CameraRollDomain:/, "Photos & videos"],
  [/^MediaDomain:Library\/SMS\//, "Message attachments"],
  [/^HomeDomain:Library\/SMS\//, "Messages"],
  [/^HomeDomain:Library\/AddressBook\//, "Contacts"],
  [/^HomeDomain:Library\/CallHistory/, "Call history"],
  [/^HomeDomain:Library\/Calendar\//, "Calendar"],
  [/^(HomeDomain:Library\/Notes\/|AppDomainGroup-group\.com\.apple\.notes)/, "Notes"],
  [/^HomeDomain:Library\/(Safari|Cookies)\//, "Safari"],
  [/^HomeDomain:Library\/Recordings\//, "Voice memos"],
  [/^HealthDomain/, "Health"],
  [/^KeychainDomain/, "Passwords (keychain)"],
  [/^AppDomain/, "App data"],
  [/^MediaDomain/, "Other media"],
  [/^(HomeDomain|RootDomain|WirelessDomain|SystemPreferencesDomain|ManagedPreferencesDomain|KeyboardDomain|DatabaseDomain|InstallDomain|ProtectedDomain|Sys)/, "Settings & system"],
];

/** What a backed-up file is, from its Manifest.db domain and path. */
export function backupCategory(domain: string, relativePath: string): string {
  const key = `${domain}:${relativePath}`;
  return DOMAIN_CATEGORIES.find(([re]) => re.test(key))?.[1] ?? "Other";
}

/** Backup service busy: usually right after a cancelled backup, which leaves the iPhone's side running. */
export const BACKUP_SERVICE_BUSY = /version exchange|could not start service|could not connect to mobilebackup2/i;

// idevicebackup2 output → what the person should do. First match wins.
const BACKUP_ERRORS: [RegExp, string][] = [
  [/waiting for passcode[\s\S]*(could not receive|aborted)/i, "The iPhone asked for its passcode to allow the backup and didn't get it in time. Unlock the iPhone, start again, and enter the passcode on the phone when it asks."],
  [/no device found|device .* not found/i, "The iPhone was disconnected. Reconnect it, unlock it, and try again."],
  [BACKUP_SERVICE_BUSY, "The iPhone's backup service didn't respond. This happens right after a backup is cancelled, or while the iPhone is locked. Unlock the iPhone, wait a minute (or unplug and reconnect it), then try again."],
  [/find my/i, "Turn off Find My on the iPhone (Settings › your name › Find My), then try again."],
  [/backup encryption is not enabled/i, "Backup encryption is already off."],
  [/could not (enable|disable) backup encryption/i, "The iPhone didn't change the encryption setting. If it asked for its passcode, enter it on the iPhone and try again."],
  [/password is required|wrong password|invalid password|bad password/i, "That backup password isn't right."],
  [/device is locked|passcode/i, "Unlock the iPhone and keep it unlocked until this finishes."],
];

/** Plain-language reason for a backup tool failure, or undefined when the output isn't recognised. */
export const explainBackupOutput = (output: string) => BACKUP_ERRORS.find(([re]) => re.test(output))?.[1];

/** Best one-line reason from a failed tool's output: its ERROR line, else its last line. */
export function failureReason(output: string): string | undefined {
  const lines = output.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^error/i.test(l)) ?? lines.at(-1);
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Scalar root of `plistutil -n KEY -f xml` output (JSON output can't hold a bare scalar). */
export function parsePlistScalar(xml: string): string | boolean | undefined {
  const m = xml.match(/<plist[^>]*>\s*(?:<(string|date|integer|real)>([\s\S]*?)<\/\1>|<(true|false)\/>)/);
  if (!m) return undefined;
  if (m[3]) return m[3] === "true";
  return m[2].replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENTITIES[e]);
}

// ProductType → marketing name. Sources: EveryMac and iPhoneSoft identifier lists; iPhone19,x from
// a NextDNS community thread (not yet in Apple's docs). Unknown types fall back to the raw code.
const IPHONE_NAMES: Record<string, string> = {
  "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max", "iPhone12,8": "iPhone SE (2nd generation)",
  "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
  "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max", "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13",
  "iPhone14,6": "iPhone SE (3rd generation)", "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
  "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max", "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
  "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
  "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus", "iPhone17,5": "iPhone 16e",
  "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max", "iPhone18,3": "iPhone 17", "iPhone18,4": "iPhone Air", "iPhone18,5": "iPhone 17e",
  "iPhone19,3": "iPhone 18 Pro Max", "iPhone19,7": "iPhone 18 Pro Max",
};

export const modelName = (productType: string | undefined) => (productType ? (IPHONE_NAMES[productType] ?? productType) : undefined);

/**
 * Battery health from the AppleSmartBattery registry entry: full-charge capacity vs design, capped
 * at 100%. Newer iOS keeps the capacities under BatteryData; older ones at the top level.
 */
export function batteryHealth(entry: Record<string, unknown>): { health?: number; cycles?: number; charging?: boolean } {
  const data = { ...entry, ...((entry.BatteryData as Record<string, unknown> | undefined) ?? {}) };
  const design = Number(data.DesignCapacity);
  const full = Number(data.NominalChargeCapacity ?? data.AppleRawMaxCapacity);
  return {
    health: design > 0 && full > 0 ? Math.min(100, Math.round((full / design) * 100)) : undefined,
    cycles: Number.isFinite(Number(entry.CycleCount)) ? Number(entry.CycleCount) : undefined,
    charging: typeof entry.IsCharging === "boolean" ? entry.IsCharging : undefined,
  };
}

export function formatBytes(value: string | undefined): string | undefined {
  const n = Number(value);
  if (!value || !Number.isFinite(n)) return undefined;
  return `${(n / 1e9).toFixed(1)} GB`;
}

/**
 * Single HTTP byte range ("bytes=0-", "bytes=100-199", "bytes=-500") against a file size.
 * undefined = no usable Range header (send the whole file); "unsatisfiable" = answer 416.
 */
export function parseByteRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start >= size || start > end ? "unsatisfiable" : { start, end };
}
