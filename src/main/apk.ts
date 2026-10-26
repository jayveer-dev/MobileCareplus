// Android app packages: just enough of the binary formats to find an app's launcher icon.
// Pure parsing (no Electron), so `node --test` covers it.
//   Binary XML (AndroidManifest.xml, res/*.xml): string pool + resource-id map + element chunks.
//   resources.arsc: value strings + per-package type chunks, one per configuration (density…).

const RES_STRING_POOL = 0x0001;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_END_ELEMENT = 0x0103;
const RES_XML_RESOURCE_MAP = 0x0180;
const RES_TABLE_PACKAGE = 0x0200;
const RES_TABLE_TYPE = 0x0201;

// Res_value data types.
export const TYPE_REFERENCE = 0x01;
export const TYPE_ATTRIBUTE = 0x02;
export const TYPE_STRING = 0x03;
export const TYPE_FLOAT = 0x04;
export const TYPE_DIMENSION = 0x05;
export const TYPE_INT_DEC = 0x10;
export const TYPE_INT_HEX = 0x11;
export const TYPE_INT_BOOLEAN = 0x12;
const isColor = (t: number) => t >= 0x1c && t <= 0x1f;

export interface ResValue {
  type: number;
  data: number;
  /** For string values: the text. */
  string?: string;
}

function stringPool(buf: Buffer, at: number): string[] {
  const count = buf.readUInt32LE(at + 8);
  const utf8 = (buf.readUInt32LE(at + 16) & 0x100) !== 0;
  const stringsStart = at + buf.readUInt32LE(at + 20);
  const headerSize = buf.readUInt16LE(at + 2);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = stringsStart + buf.readUInt32LE(at + headerSize + i * 4);
    if (utf8) {
      // Length in characters, then in bytes; each one byte, or two when the high bit is set.
      if (buf[p++] & 0x80) p++;
      let len = buf[p++];
      if (len & 0x80) len = ((len & 0x7f) << 8) | buf[p++];
      out.push(buf.toString("utf8", p, p + len));
    } else {
      let len = buf.readUInt16LE(p);
      p += 2;
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p);
        p += 2;
      }
      out.push(buf.toString("utf16le", p, p + len * 2));
    }
  }
  return out;
}

// ---- Binary XML

export interface XmlAttr {
  /** Attribute name as stored; may be empty in shrunk apps, so prefer resId. */
  name: string;
  /** Framework attribute id (e.g. 0x01010002 = android:icon), when known. */
  resId?: number;
  value: ResValue;
}

export interface XmlElement {
  name: string;
  attrs: XmlAttr[];
  children: XmlElement[];
}

export function parseXml(buf: Buffer): XmlElement {
  let strings: string[] = [];
  let resMap: number[] = [];
  const root: XmlElement = { name: "#document", attrs: [], children: [] };
  const stack = [root];
  let p = buf.readUInt16LE(2); // past the file header
  while (p + 8 <= buf.length) {
    const type = buf.readUInt16LE(p);
    const headerSize = buf.readUInt16LE(p + 2);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8) break;
    if (type === RES_STRING_POOL) strings = stringPool(buf, p);
    else if (type === RES_XML_RESOURCE_MAP) resMap = Array.from({ length: (size - headerSize) / 4 }, (_, i) => buf.readUInt32LE(p + headerSize + i * 4));
    else if (type === RES_XML_START_ELEMENT) {
      const ext = p + headerSize;
      const name = strings[buf.readUInt32LE(ext + 4)] ?? "";
      const attrStart = buf.readUInt16LE(ext + 8);
      const attrSize = buf.readUInt16LE(ext + 10);
      const attrCount = buf.readUInt16LE(ext + 12);
      const attrs: XmlAttr[] = [];
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const nameIdx = buf.readUInt32LE(a + 4);
        const raw = buf.readUInt32LE(a + 8);
        const valueType = buf[a + 15];
        const data = buf.readUInt32LE(a + 16);
        attrs.push({
          name: strings[nameIdx] ?? "",
          resId: resMap[nameIdx],
          value: { type: valueType, data, string: valueType === TYPE_STRING ? strings[raw === 0xffffffff ? data : raw] : undefined },
        });
      }
      const el: XmlElement = { name, attrs, children: [] };
      stack.at(-1)!.children.push(el);
      stack.push(el);
    } else if (type === RES_XML_END_ELEMENT && stack.length > 1) stack.pop();
    p += size;
  }
  return root.children[0] ?? root;
}

/** First element with this name, depth first. */
export function findElement(el: XmlElement, name: string): XmlElement | undefined {
  if (el.name === name) return el;
  for (const c of el.children) {
    const hit = findElement(c, name);
    if (hit) return hit;
  }
  return undefined;
}

/** Attribute by framework id, falling back to its name (ids are reliable; names can be stripped). */
export const attr = (el: XmlElement, resId: number, name: string) => el.attrs.find((a) => a.resId === resId) ?? el.attrs.find((a) => a.name === name);

// ---- resources.arsc

export interface ResEntry {
  value: ResValue;
  /** Screen density of the configuration (0 = any; 0xfffe = anydpi; 0xffff = none). */
  density: number;
  /** Minimum SDK of the configuration (26 for adaptive icons in mipmap-anydpi-v26). */
  sdk: number;
}

export interface ResTable {
  /** All configurations of a resource id. */
  entries(resId: number): ResEntry[];
}

export function parseResTable(buf: Buffer): ResTable {
  const headerSize = buf.readUInt16LE(2);
  const values = stringPool(buf, headerSize);
  const index = new Map<number, ResEntry[]>();
  let p = headerSize + buf.readUInt32LE(headerSize + 4);
  while (p + 8 <= buf.length) {
    const type = buf.readUInt16LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (type === RES_TABLE_PACKAGE) readPackage(buf, p, values, index);
    if (size < 8) break;
    p += size;
  }
  return { entries: (id) => index.get(id) ?? [] };
}

function readPackage(buf: Buffer, at: number, values: string[], index: Map<number, ResEntry[]>) {
  const packageId = buf.readUInt32LE(at + 8);
  const end = at + buf.readUInt32LE(at + 4);
  let p = at + buf.readUInt16LE(at + 2);
  while (p + 8 <= end) {
    const type = buf.readUInt16LE(p);
    const headerSize = buf.readUInt16LE(p + 2);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8) break;
    if (type === RES_TABLE_TYPE) {
      const typeId = buf[p + 8];
      const flags = buf[p + 9];
      const entryCount = buf.readUInt32LE(p + 12);
      const entriesStart = p + buf.readUInt32LE(p + 16);
      const config = p + 20;
      const configSize = buf.readUInt32LE(config);
      const density = configSize >= 16 ? buf.readUInt16LE(config + 14) : 0;
      const sdk = configSize >= 28 ? buf.readUInt16LE(config + 24) : 0;
      const sparse = (flags & 0x01) !== 0;
      const offset16 = (flags & 0x02) !== 0;
      const offsets = p + headerSize;
      const add = (entry: number, off: number) => {
        const e = entriesStart + off;
        const entryFlags = buf.readUInt16LE(e + 2);
        let value: ResValue;
        if (entryFlags & 0x08) value = { type: entryFlags >> 8, data: buf.readUInt32LE(e + 4) }; // compact entry
        else if (entryFlags & 0x01) return; // complex (style, array): not needed for icons
        else value = { type: buf[e + 8 + 3], data: buf.readUInt32LE(e + 8 + 4) };
        if (value.type === TYPE_STRING) value.string = values[value.data];
        const id = ((packageId & 0xff) << 24) | (typeId << 16) | entry;
        const list = index.get(id >>> 0) ?? [];
        list.push({ value, density, sdk });
        index.set(id >>> 0, list);
      };
      if (sparse) {
        for (let i = 0; i < entryCount; i++) add(buf.readUInt16LE(offsets + i * 4), buf.readUInt16LE(offsets + i * 4 + 2) * 4);
      } else if (offset16) {
        for (let i = 0; i < entryCount; i++) {
          const o = buf.readUInt16LE(offsets + i * 2);
          if (o !== 0xffff) add(i, o * 4);
        }
      } else {
        for (let i = 0; i < entryCount; i++) {
          const o = buf.readUInt32LE(offsets + i * 4);
          if (o !== 0xffffffff) add(i, o);
        }
      }
    }
    p += size;
  }
}

/** ARGB color value → CSS rgba(). */
export function cssColor(v: ResValue): string | undefined {
  if (!isColor(v.type)) return undefined;
  // Stored as 0xAARRGGBB whatever the source format (#rgb gets alpha ff).
  const argb = v.data >>> 0;
  const a = ((argb >>> 24) & 0xff) / 255;
  return `rgba(${(argb >>> 16) & 0xff},${(argb >>> 8) & 0xff},${argb & 0xff},${+a.toFixed(3)})`;
}
