// WhatsApp's end-to-end encrypted Android backup (msgstore.db.crypt15). Pure crypto, no Electron.
//
// File: [protobuf size][optional 0x01 feature flag][BackupPrefix protobuf][AES-256-GCM ciphertext]
// [16-byte GCM tag][optional 16-byte MD5 of everything before it]. BackupPrefix field 3 holds the
// IV (its field 1). The plaintext is a zlib-compressed SQLite database.
// The cipher key comes from the person's 64-digit (hex) key: HMAC-SHA256 with a zero key, then
// HMAC-SHA256 of "backup encryption" + 0x01 (one HKDF step). The key is never stored.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { protoFields } from "./parse.ts"; // .ts so node --test can load this module directly

export class WrongKeyError extends Error {}

/** The 64-digit key as WhatsApp shows it (groups of 4, any spacing or case) → 32 bytes. */
export function parseBackupKey(text: string): Buffer {
  const hex = text.replace(/[\s-]/g, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("The key is 64 characters, digits 0–9 and letters a–f, as WhatsApp showed it.");
  return Buffer.from(hex, "hex");
}

export function cipherKey(rootKey: Buffer): Buffer {
  const seed = createHmac("sha256", Buffer.alloc(32)).update(rootKey).digest();
  return createHmac("sha256", seed).update(Buffer.concat([Buffer.from("backup encryption"), Buffer.from([1])])).digest();
}

function header(file: Buffer): { iv: Buffer; bodyStart: number } {
  const size = file[0];
  // A protobuf here starts with field 1 (0x08), so a leading 0x01 can only be the feature flag.
  const start = file[1] === 0x01 ? 2 : 1;
  const prefix = file.subarray(start, start + size);
  if (!size || prefix.length !== size) throw new Error("This isn't a WhatsApp backup file.");
  const ivField = protoFields(prefix).find(([f, v]) => f === 3 && Buffer.isBuffer(v))?.[1] as Buffer | undefined;
  const iv = ivField && (protoFields(ivField).find(([f, v]) => f === 1 && Buffer.isBuffer(v) && v.length === 16)?.[1] as Buffer | undefined);
  if (!iv) throw new Error("This backup isn't end-to-end encrypted with a 64-digit key, so it can't be read on a computer.");
  return { iv, bodyStart: start + size };
}

/**
 * Decrypts and decompresses a crypt15 file. ponytail: whole file in memory (chat databases are
 * usually tens of MB); stream it if multi-GB databases show up.
 */
export function decryptCrypt15(file: Buffer, rootKey: Buffer): Buffer {
  const { iv, bodyStart } = header(file);
  const key = cipherKey(rootKey);
  const body = file.subarray(bodyStart);
  // The tag is last, or followed by an MD5 checksum; authentication tells which.
  for (const trailer of [16, 32]) {
    if (body.length < trailer) break;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(body.subarray(body.length - trailer, body.length - trailer + 16));
      const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - trailer)), decipher.final()]);
      return plain[0] === 0x78 ? inflateSync(plain) : plain;
    } catch {
      // try the other layout
    }
  }
  throw new WrongKeyError("That key doesn't open this backup. Check it against the key WhatsApp showed when you turned on encrypted backup.");
}

/** The inverse, in the same layout WhatsApp writes (feature flag, tag, MD5); used to put chats back on a phone. */
export function encryptCrypt15(plain: Buffer, rootKey: Buffer, iv = randomBytes(16)): Buffer {
  const ivMessage = Buffer.concat([Buffer.from([0x0a, iv.length]), iv]);
  const prefix = Buffer.concat([Buffer.from([0x08, 0x01, 0x1a, ivMessage.length]), ivMessage]);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(rootKey), iv);
  const body = Buffer.concat([cipher.update(deflateSync(plain)), cipher.final(), cipher.getAuthTag()]);
  const out = Buffer.concat([Buffer.from([prefix.length, 0x01]), prefix, body]);
  return Buffer.concat([out, createHash("md5").update(out).digest()]);
}
