// Binary property list ("bplist00") reader. Backups store per-file metadata this way inside
// Manifest.db, and Manifest.plist is one too. Pure, so `node --test` covers it.

export class Uid {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export type PlistValue = null | boolean | number | bigint | string | Date | Buffer | Uid | PlistValue[] | { [key: string]: PlistValue };

const APPLE_EPOCH_MS = 978_307_200_000;

export function parseBinaryPlist(buf: Buffer): PlistValue {
  if (buf.length < 40 || buf.toString("latin1", 0, 8) !== "bplist00") throw new Error("Not a binary plist");
  const trailer = buf.subarray(buf.length - 32);
  const offsetSize = trailer[6];
  const refSize = trailer[7];
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const tableOffset = Number(trailer.readBigUInt64BE(24));
  if (topObject >= numObjects || tableOffset + numObjects * offsetSize > buf.length - 32) throw new Error("Corrupt binary plist");

  const readUInt = (pos: number, size: number) => {
    let n = 0;
    for (let i = 0; i < size; i++) n = n * 256 + buf[pos + i];
    return n;
  };
  const offsetOf = (ref: number) => {
    if (ref >= numObjects) throw new Error("Corrupt binary plist reference");
    return readUInt(tableOffset + ref * offsetSize, offsetSize);
  };

  const visiting = new Set<number>();
  const parse = (ref: number): PlistValue => {
    if (visiting.has(ref)) throw new Error("Cyclic binary plist");
    visiting.add(ref);
    try {
      return parseAt(offsetOf(ref));
    } finally {
      visiting.delete(ref);
    }
  };

  // Length of strings/data/collections: low nibble, or 0xF followed by an int object.
  const lengthAt = (pos: number, nibble: number): [number, number] => {
    if (nibble !== 0xf) return [nibble, pos + 1];
    const intMarker = buf[pos + 1];
    const size = 1 << (intMarker & 0xf);
    return [readUInt(pos + 2, size), pos + 2 + size];
  };

  const parseAt = (pos: number): PlistValue => {
    const marker = buf[pos];
    const type = marker >> 4;
    const nibble = marker & 0xf;
    switch (type) {
      case 0x0:
        return nibble === 0x8 ? false : nibble === 0x9 ? true : null;
      case 0x1: {
        const size = 1 << nibble;
        if (size === 8) {
          const n = buf.readBigInt64BE(pos + 1);
          return n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : n;
        }
        if (size === 16) return buf.readBigInt64BE(pos + 9);
        return readUInt(pos + 1, size);
      }
      case 0x2:
        return nibble === 2 ? buf.readFloatBE(pos + 1) : buf.readDoubleBE(pos + 1);
      case 0x3:
        return new Date(APPLE_EPOCH_MS + buf.readDoubleBE(pos + 1) * 1000);
      case 0x4: {
        const [len, start] = lengthAt(pos, nibble);
        return Buffer.from(buf.subarray(start, start + len));
      }
      case 0x5: {
        const [len, start] = lengthAt(pos, nibble);
        return buf.toString("latin1", start, start + len);
      }
      case 0x6: {
        const [len, start] = lengthAt(pos, nibble);
        const utf16be = buf.subarray(start, start + len * 2);
        return Buffer.from(utf16be).swap16().toString("utf16le");
      }
      case 0x8:
        return new Uid(readUInt(pos + 1, nibble + 1));
      case 0xa: {
        const [len, start] = lengthAt(pos, nibble);
        return Array.from({ length: len }, (_, i) => parse(readUInt(start + i * refSize, refSize)));
      }
      case 0xd: {
        const [len, start] = lengthAt(pos, nibble);
        const out: { [key: string]: PlistValue } = {};
        for (let i = 0; i < len; i++) {
          const key = parse(readUInt(start + i * refSize, refSize));
          out[String(key)] = parse(readUInt(start + (len + i) * refSize, refSize));
        }
        return out;
      }
      default:
        throw new Error(`Unsupported binary plist object 0x${marker.toString(16)}`);
    }
  };
  return parse(topObject);
}

/**
 * Root object of an NSKeyedArchiver plist with references resolved one level deep, which is
 * how backups store each file's MBFile record (Size, ProtectionClass, EncryptionKey…).
 */
export function keyedArchiveRoot(archive: PlistValue): Record<string, PlistValue> {
  const objects = (archive as Record<string, PlistValue>)?.$objects as PlistValue[] | undefined;
  const top = ((archive as Record<string, PlistValue>)?.$top as Record<string, PlistValue> | undefined)?.root;
  if (!Array.isArray(objects) || !(top instanceof Uid)) throw new Error("Not a keyed archive");
  const resolve = (v: PlistValue) => (v instanceof Uid ? objects[v.value] : v);
  const root = resolve(top) as Record<string, PlistValue>;
  return Object.fromEntries(Object.entries(root).map(([k, v]) => [k, resolve(v)]));
}

/** NSData inside a keyed archive is either raw data or a dict holding it under NS.data. */
export const archivedData = (v: PlistValue | undefined): Buffer | undefined =>
  Buffer.isBuffer(v) ? v : v && typeof v === "object" && !(v instanceof Date) && !(v instanceof Uid) && !Array.isArray(v) && Buffer.isBuffer((v as Record<string, PlistValue>)["NS.data"]) ? ((v as Record<string, PlistValue>)["NS.data"] as Buffer) : undefined;

// ---- Writer (for iPhone restore sets: Manifest.db rows hold MBFile keyed archives).

/**
 * Serialises a value as "bplist00". Objects are written once each (no de-duplication), with
 * 1-, 2- or 4-byte references and offsets as the sizes require. Dictionary keys are strings.
 */
export function writeBinaryPlist(root: PlistValue): Buffer {
  const objects: Buffer[] = [];
  const intBytes = (n: number) => (n < 0x100 ? 1 : n < 0x10000 ? 2 : 4);
  const uintBE = (n: number, size: number) => {
    const b = Buffer.alloc(size);
    if (size === 1) b.writeUInt8(n);
    else if (size === 2) b.writeUInt16BE(n);
    else if (size === 4) b.writeUInt32BE(n);
    else b.writeBigUInt64BE(BigInt(n));
    return b;
  };
  // First pass: count objects so reference size is known before encoding.
  const count = (v: PlistValue): number =>
    Array.isArray(v) ? 1 + v.reduce<number>((s, x) => s + count(x), 0)
    : v && typeof v === "object" && !(v instanceof Date) && !(v instanceof Uid) && !Buffer.isBuffer(v)
      ? 1 + Object.entries(v).reduce((s, [, x]) => s + 1 + count(x), 0)
      : 1;
  const refSize = intBytes(count(root));

  const lengthMarker = (type: number, len: number) =>
    len < 15 ? Buffer.from([(type << 4) | len]) : Buffer.concat([Buffer.from([(type << 4) | 0xf]), intObject(len)]);
  function intObject(n: number | bigint): Buffer {
    const big = BigInt(n);
    if (big < 0n || big > 0xffffffffn) {
      const b = Buffer.alloc(9);
      b[0] = 0x13;
      b.writeBigInt64BE(big, 1);
      return b;
    }
    const v = Number(big);
    const size = v < 0x100 ? 1 : v < 0x10000 ? 2 : 4;
    return Buffer.concat([Buffer.from([0x10 | Math.log2(size)]), uintBE(v, size)]);
  }

  const add = (v: PlistValue): number => {
    const index = objects.length;
    objects.push(Buffer.alloc(0)); // reserve the slot so children get later indexes
    let body: Buffer;
    if (v === null) body = Buffer.from([0x00]);
    else if (typeof v === "boolean") body = Buffer.from([v ? 0x09 : 0x08]);
    else if (typeof v === "bigint") body = intObject(v);
    else if (typeof v === "number") {
      if (Number.isInteger(v)) body = intObject(v);
      else {
        body = Buffer.alloc(9);
        body[0] = 0x23;
        body.writeDoubleBE(v, 1);
      }
    } else if (v instanceof Date) {
      body = Buffer.alloc(9);
      body[0] = 0x33;
      body.writeDoubleBE((v.getTime() - APPLE_EPOCH_MS) / 1000, 1);
    } else if (Buffer.isBuffer(v)) body = Buffer.concat([lengthMarker(0x4, v.length), v]);
    else if (typeof v === "string") {
      // ASCII strings are stored as bytes; anything else as UTF-16 big-endian.
      body = /^[\x00-\x7f]*$/.test(v)
        ? Buffer.concat([lengthMarker(0x5, v.length), Buffer.from(v, "latin1")])
        : Buffer.concat([lengthMarker(0x6, v.length), Buffer.from(v, "utf16le").swap16()]);
    } else if (v instanceof Uid) body = Buffer.concat([Buffer.from([0x80 | (intBytes(v.value) - 1)]), uintBE(v.value, intBytes(v.value))]);
    else if (Array.isArray(v)) {
      const refs = v.map(add);
      body = Buffer.concat([lengthMarker(0xa, refs.length), ...refs.map((r) => uintBE(r, refSize))]);
    } else {
      const entries = Object.entries(v);
      const keys = entries.map(([k]) => add(k));
      const values = entries.map(([, x]) => add(x));
      body = Buffer.concat([lengthMarker(0xd, entries.length), ...[...keys, ...values].map((r) => uintBE(r, refSize))]);
    }
    objects[index] = body;
    return index;
  };
  add(root);

  const header = Buffer.from("bplist00", "latin1");
  const offsets: number[] = [];
  let pos = header.length;
  for (const o of objects) {
    offsets.push(pos);
    pos += o.length;
  }
  const offsetSize = pos < 0x100 ? 1 : pos < 0x10000 ? 2 : pos < 0x100000000 ? 4 : 8;
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(pos), 24);
  return Buffer.concat([header, ...objects, ...offsets.map((o) => uintBE(o, offsetSize)), trailer]);
}

/** NSKeyedArchiver form of one flat object (as iOS stores each file's MBFile record in Manifest.db). */
export function keyedArchive(className: string, fields: Record<string, PlistValue>): Buffer {
  const objects: PlistValue[] = ["$null"];
  const root: Record<string, PlistValue> = {};
  objects.push(root);
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string" || Buffer.isBuffer(v)) {
      // Strings and data are referenced by UID, like NSKeyedArchiver does.
      objects.push(v);
      root[k] = new Uid(objects.length - 1);
    } else root[k] = v;
  }
  objects.push({ $classes: [className, "NSObject"], $classname: className });
  root.$class = new Uid(objects.length - 1);
  return writeBinaryPlist({ $version: 100000, $archiver: "NSKeyedArchiver", $top: { root: new Uid(1) }, $objects: objects });
}
