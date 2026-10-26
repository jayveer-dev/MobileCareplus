// iOS encrypted backup keys (iOS 10.2+ format). Pure crypto, no Electron, so `node --test` covers it.
//
// Manifest.plist holds a keybag. The backup password, stretched with PBKDF2-SHA256 (DPSL/DPIC)
// then PBKDF2-SHA1 (SALT/ITER), unwraps each protection class key (AES key wrap, RFC 3394).
// Each file's own key is wrapped with its class key; files are AES-256-CBC with a zero IV.
import { createCipheriv, createDecipheriv, pbkdf2 } from "node:crypto";

export interface ClassKey {
  protectionClass: number;
  wrap: number;
  wrappedKey: Buffer;
}

export interface Keybag {
  salt: Buffer;
  iterations: number;
  /** Present since iOS 10.2: the first, SHA-256 stretch. */
  dpsl?: Buffer;
  dpic?: number;
  classKeys: ClassKey[];
}

// Keybag WRAP flag: the class key is wrapped with the password-derived key.
const WRAP_PASSCODE = 2;

/** Keybag TLV: 4-byte tag, 4-byte big-endian length, value. A UUID after the header starts each class key. */
export function parseKeybag(buf: Buffer): Keybag {
  const header: Record<string, Buffer> = {};
  const classKeys: ClassKey[] = [];
  let current: Record<string, Buffer> | undefined;
  let seenHeaderUuid = false;
  const flush = () => {
    if (current?.CLAS && current.WPKY)
      classKeys.push({ protectionClass: current.CLAS.readUInt32BE(0), wrap: current.WRAP?.readUInt32BE(0) ?? 0, wrappedKey: current.WPKY });
  };
  for (let i = 0; i + 8 <= buf.length; ) {
    const tag = buf.toString("latin1", i, i + 4);
    const len = buf.readUInt32BE(i + 4);
    const value = buf.subarray(i + 8, i + 8 + len);
    i += 8 + len;
    if (tag === "UUID") {
      if (!seenHeaderUuid) {
        seenHeaderUuid = true;
        header.UUID = value;
        continue;
      }
      flush();
      current = {};
    }
    (current ?? header)[tag] = value;
  }
  flush();
  if (!header.SALT || !header.ITER) throw new Error("This backup's keybag is missing its salt.");
  return {
    salt: header.SALT,
    iterations: header.ITER.readUInt32BE(0),
    dpsl: header.DPSL,
    dpic: header.DPIC?.readUInt32BE(0),
    classKeys,
  };
}

const pbkdf2Async = (password: Buffer | string, salt: Buffer, iterations: number, digest: string) =>
  new Promise<Buffer>((resolve, reject) => pbkdf2(password, salt, iterations, 32, digest, (err, key) => (err ? reject(err) : resolve(key))));

/** Key that unwraps the class keys. The SHA-256 stretch runs ~10 million rounds: a few seconds. */
export async function passwordKey(password: string, keybag: Keybag): Promise<Buffer> {
  const stretched = keybag.dpsl && keybag.dpic ? await pbkdf2Async(password, keybag.dpsl, keybag.dpic, "sha256") : Buffer.from(password, "utf8");
  return pbkdf2Async(stretched, keybag.salt, keybag.iterations, "sha1");
}

const DEFAULT_IV = Buffer.from("a6a6a6a6a6a6a6a6", "hex");

const aesBlock = (kek: Buffer, block: Buffer, decrypt: boolean) => {
  const algo = `aes-${kek.length * 8}-ecb`;
  const c = decrypt ? createDecipheriv(algo, kek, null) : createCipheriv(algo, kek, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
};

/** RFC 3394 AES key unwrap. Returns undefined when the integrity check fails (wrong password). */
export function aesUnwrap(kek: Buffer, wrapped: Buffer): Buffer | undefined {
  const n = wrapped.length / 8 - 1;
  if (!Number.isInteger(n) || n < 1) return undefined;
  let a = Buffer.from(wrapped.subarray(0, 8));
  const r = Array.from({ length: n }, (_, i) => Buffer.from(wrapped.subarray(8 + i * 8, 16 + i * 8)));
  for (let j = 5; j >= 0; j--) {
    for (let i = n; i >= 1; i--) {
      const t = BigInt(n * j + i);
      const xored = Buffer.from(a);
      xored.writeBigUInt64BE(a.readBigUInt64BE(0) ^ t, 0);
      const b = aesBlock(kek, Buffer.concat([xored, r[i - 1]]), true);
      a = b.subarray(0, 8);
      r[i - 1] = b.subarray(8, 16);
    }
  }
  return a.equals(DEFAULT_IV) ? Buffer.concat(r) : undefined;
}

/** RFC 3394 AES key wrap (used by tests to build fixtures). */
export function aesWrap(kek: Buffer, key: Buffer): Buffer {
  const n = key.length / 8;
  let a = Buffer.from(DEFAULT_IV);
  const r = Array.from({ length: n }, (_, i) => Buffer.from(key.subarray(i * 8, i * 8 + 8)));
  for (let j = 0; j <= 5; j++) {
    for (let i = 1; i <= n; i++) {
      const b = aesBlock(kek, Buffer.concat([a, r[i - 1]]), false);
      a = Buffer.from(b.subarray(0, 8));
      a.writeBigUInt64BE(a.readBigUInt64BE(0) ^ BigInt(n * j + i), 0);
      r[i - 1] = b.subarray(8, 16);
    }
  }
  return Buffer.concat([a, ...r]);
}

export class WrongPasswordError extends Error {
  constructor() {
    super("That password doesn't unlock this backup. It's the password set when backup encryption was turned on, not the iPhone passcode.");
  }
}

/** Protection class → unwrapped class key. Throws WrongPasswordError if the password is wrong. */
export async function unlockKeybag(keybag: Keybag, password: string): Promise<Map<number, Buffer>> {
  const kek = await passwordKey(password, keybag);
  const keys = new Map<number, Buffer>();
  for (const ck of keybag.classKeys) {
    if (!(ck.wrap & WRAP_PASSCODE)) continue;
    const key = aesUnwrap(kek, ck.wrappedKey);
    if (!key) throw new WrongPasswordError();
    keys.set(ck.protectionClass, key);
  }
  if (keys.size === 0) throw new WrongPasswordError();
  return keys;
}

/**
 * Unwraps a per-file or manifest key: 4-byte little-endian protection class, then the wrapped key.
 */
export function unwrapFileKey(classKeys: Map<number, Buffer>, persistentKey: Buffer): Buffer {
  const protectionClass = persistentKey.readUInt32LE(0);
  const classKey = classKeys.get(protectionClass);
  if (!classKey) throw new Error(`This backup uses protection class ${protectionClass}, which the password didn't unlock.`);
  const key = aesUnwrap(classKey, persistentKey.subarray(4));
  if (!key) throw new Error("A file key in this backup is damaged.");
  return key;
}

/** AES-256-CBC, zero IV, no padding removal: callers trim to the recorded size. */
export const fileDecipher = (key: Buffer) => {
  const d = createDecipheriv("aes-256-cbc", key, Buffer.alloc(16));
  d.setAutoPadding(false);
  return d;
};
