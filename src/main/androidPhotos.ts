// Android photos and videos, from the phone's media index (MediaStore) over adb. The phone makes
// the thumbnails itself; we fetch them only for tiles on screen and keep them for the session.
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { PhotoAlbum, PhotoAsset, PhotoLibrary } from "../shared/types";
import { parseContentRows } from "./parse";
import { run, spawnTool } from "./tools";

const COLUMNS = ["_id", "_data", "_display_name", "datetaken", "date_added", "_size", "width", "height", "bucket_id", "bucket_display_name", "is_favorite", "duration"];
const URI = { photo: "content://media/external/images/media", video: "content://media/external/video/media" } as const;
/** Shared storage as apps see it; paths in the library are relative to it. */
const ROOT = "/storage/emulated/0/";
export const phonePath = (path: string) => `/sdcard/${path}`;

const num = (v: string | undefined) => (v === undefined ? undefined : Number(v) || undefined);

async function query(id: string, kind: PhotoAsset["kind"]): Promise<{ asset: PhotoAsset; folder?: string }[]> {
  const out = await run("adb", ["-s", id, "shell", "content", "query", "--uri", URI[kind], "--projection", COLUMNS.join(":")], { timeoutMs: 120_000 });
  return parseContentRows(out, COLUMNS)
    .filter((r) => r._id && r._data?.startsWith(ROOT))
    .map((r) => {
      const taken = num(r.datetaken) ?? (num(r.date_added) ?? 0) * 1000;
      const asset: PhotoAsset = {
        id: Number(r._id),
        path: r._data!.slice(ROOT.length),
        name: r._display_name ?? r._data!.split("/").at(-1)!,
        kind,
        date: taken ? new Date(taken).toISOString() : undefined,
        bytes: num(r._size),
        width: num(r.width),
        height: num(r.height),
        duration: kind === "video" && num(r.duration) ? num(r.duration)! / 1000 : undefined,
        live: false,
        screenshot: r.bucket_display_name === "Screenshots",
        favorite: r.is_favorite === "1",
        hidden: false,
        deleted: false,
        albums: r.bucket_id ? [Number(r.bucket_id)] : [],
      };
      return { asset, folder: r.bucket_display_name };
    });
}

/** Photos and videos, newest first; folders (Camera, Screenshots, WhatsApp Images…) are the albums. */
export async function androidLibrary(id: string, duplicates: (assets: PhotoAsset[]) => number[][]): Promise<PhotoLibrary> {
  const [photos, videos] = await Promise.all([query(id, "photo"), query(id, "video")]);
  const albums = new Map<number, PhotoAlbum>();
  for (const { asset, folder } of [...photos, ...videos]) {
    const albumId = asset.albums[0];
    if (albumId === undefined) continue;
    const album = albums.get(albumId) ?? { id: albumId, title: folder ?? "Folder", count: 0 };
    album.count++;
    albums.set(albumId, album);
  }
  const assets = [...photos, ...videos].map((x) => x.asset).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return { assets, albums: [...albums.values()].sort((a, b) => b.count - a.count), duplicates: duplicates(assets) };
}

// Each thumbnail is one adb call (~1 s, mostly connection setup), so a few run at once.
const THUMB_CONCURRENCY = 6;
let active = 0;
const waiting: (() => void)[] = [];
const inFlight = new Map<string, Promise<string | undefined>>();

/** The phone's own thumbnail for an item, saved as file (once); undefined if the phone has none. */
export function androidThumbnail(id: string, asset: PhotoAsset, file: string): Promise<string | undefined> {
  const running = inFlight.get(file);
  if (running) return running;
  const work = (async () => {
    if ((await stat(file).catch(() => undefined))?.size) return file;
    if (active >= THUMB_CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      await mkdir(join(file, ".."), { recursive: true });
      const part = `${file}.part`;
      // exec-out keeps the bytes binary-clean (shell would turn \n into \r\n).
      const child = spawnTool("adb", ["-s", id, "exec-out", "content", "read", "--uri", `${URI[asset.kind]}/${asset.id}/thumbnail`]);
      const timer = setTimeout(() => child.kill(), 30_000);
      const exited = new Promise<number | null>((resolve) => {
        child.on("close", resolve);
        child.on("error", () => resolve(-1));
      });
      // Both: the file fully written and adb finished without error.
      const ok = await pipeline(child.stdout!, createWriteStream(part))
        .then(async () => (await exited) === 0, () => false)
        .finally(() => clearTimeout(timer));
      if (!ok || !(await stat(part).catch(() => undefined))?.size) {
        await rm(part, { force: true });
        return undefined;
      }
      await rename(part, file);
      return file;
    } finally {
      active--;
      waiting.shift()?.();
    }
  })().finally(() => inFlight.delete(file));
  inFlight.set(file, work);
  return work;
}

const TRASH_CONCURRENCY = 4;

/**
 * Moves items to the phone's own Trash (MediaStore is_trashed), where the Gallery keeps them about
 * 30 days and can restore them. Returns how many were trashed and how many the phone refused.
 */
export async function androidTrash(id: string, assets: PhotoAsset[]): Promise<{ deleted: number; skipped: number }> {
  let deleted = 0;
  let skipped = 0;
  const queue = [...assets];
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      await run("adb", ["-s", id, "shell", "content", "update", "--uri", `${URI[a.kind]}/${a.id}`, "--bind", "is_trashed:i:1"], { timeoutMs: 30_000 }).then(
        () => deleted++,
        () => skipped++,
      );
    }
  };
  await Promise.all(Array.from({ length: TRASH_CONCURRENCY }, worker));
  return { deleted, skipped };
}
