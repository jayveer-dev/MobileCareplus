// The phone's photos and videos, read directly over USB (no backup). iPhone: its library database
// (/PhotoData/Photos.sqlite) and own thumbnails (/PhotoData/Thumbnails/V2/<path>/5005.JPG). Android:
// the media index (androidPhotos.ts). This module is the one owner of photo facts; Home, storage
// and Manage all read from it, whatever the phone.
import { mkdir, rm, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { app, type BrowserWindow, dialog } from "electron";
import type { PhotoAlbum, PhotoAsset, PhotoDeleteResult, PhotoLibrary, Platform } from "../shared/types";
import { androidLibrary, androidThumbnail, androidTrash, phonePath } from "./androidPhotos";
import { workDir } from "./backupSource";
import { fileSafe } from "./formats";
import { appleTime, parseAfcLongList } from "./parse";
import { startJob } from "./tasks";
import { run } from "./tools";

// ZASSET.ZKIND / ZKINDSUBTYPE: kind 0 photo, 1 video; photo subtype 2 = Live Photo, 10 = screenshot.
const KIND_VIDEO = 1;
const SUBTYPE_LIVE = 2;
const SUBTYPE_SCREENSHOT = 10;
// ZGENERICALBUM.ZKIND 2 = albums the user made.
const USER_ALBUM = 2;
const THUMB_FILE = "5005.JPG";

const libDir = (id: string) => join(workDir(), "photolib", id);
export const thumbRoot = (id: string) => join(libDir(id), "V2");

interface Synced {
  /** Phone's Photos.sqlite modification time when copied. */
  stamp: string;
  library: PhotoLibrary;
}
const synced = new Map<string, Synced>();
const platforms = new Map<string, Platform>();
const inFlight = new Map<string, Promise<PhotoLibrary>>();

/** Library change marker: Photos.sqlite and its journal's sizes and times, as the phone reports them. */
async function libraryStamp(id: string): Promise<string> {
  const entries = parseAfcLongList(await run("afcclient", ["-u", id, "--", "ls", "-l", "/PhotoData"]));
  return entries
    .filter((e) => e.name.startsWith("Photos.sqlite"))
    .map((e) => `${e.name}:${e.size}:${e.date}`)
    .join("|");
}

/**
 * Copies the library database and all thumbnails (one recursive transfer, a few seconds) when the
 * library changed since the last copy, then reads it. Concurrent callers share one refresh.
 */
export function photoLibrary(platform: Platform, id: string): Promise<PhotoLibrary> {
  platforms.set(id, platform);
  const running = inFlight.get(id);
  if (running) return running;
  const work = (platform === "android" ? refreshAndroid(id) : refresh(id)).finally(() => inFlight.delete(id));
  inFlight.set(id, work);
  return work;
}

async function refresh(id: string): Promise<PhotoLibrary> {
  const stamp = await libraryStamp(id);
  const known = synced.get(id);
  if (known?.stamp === stamp) return known.library;
  const dir = libDir(id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const name of ["Photos.sqlite", "Photos.sqlite-wal"]) {
    await run("afcclient", ["-u", id, "get", `/PhotoData/${name}`, join(dir, name)], { timeoutMs: 5 * 60_000 }).catch((e) => {
      if (name === "Photos.sqlite") throw e; // the journal is optional
    });
  }
  // Thumbnails are best effort: the grid still lists items without them.
  await run("afcclient", ["-u", id, "--", "get", "-r", "/PhotoData/Thumbnails/V2", dir], { timeoutMs: 10 * 60_000 }).catch(() => {});
  const library = readLibrary(join(dir, "Photos.sqlite"));
  synced.set(id, { stamp, library });
  return library;
}

/** Android's index answers in a few seconds, so it's simply read again each time. */
async function refreshAndroid(id: string): Promise<PhotoLibrary> {
  const library = await androidLibrary(id, findDuplicates);
  synced.set(id, { stamp: "", library });
  return library;
}

/** The library as last read, or read now; callers below act on items the person saw. */
const known = async (id: string) => synced.get(id)?.library ?? (await photoLibrary(platforms.get(id) ?? "ios", id));

/** Copies an item's original from the phone to a local file. */
export function copyFromPhone(id: string, asset: PhotoAsset, local: string, timeoutMs: number) {
  return platforms.get(id) === "android"
    ? run("adb", ["-s", id, "pull", "-a", phonePath(asset.path), local], { timeoutMs })
    : run("afcclient", ["-u", id, "get", `/${asset.path}`, local], { timeoutMs });
}

type Row = Record<string, string | number | null>;

/** Album membership lives in a join table whose number varies by iOS version (Z_34ASSETS, Z_26ASSETS…). */
function albumJoin(db: DatabaseSync): { table: string; album: string; asset: string } | undefined {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'Z_[0-9]*ASSETS'").all() as Row[]).map((r) => String(r.name));
  for (const table of tables) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => String(c.name));
    const album = cols.find((c) => /^Z_\d+ALBUMS$/.test(c));
    const asset = cols.find((c) => /^Z_\d+ASSETS$/.test(c));
    if (album && asset) return { table, album, asset };
  }
  return undefined;
}

export function readLibrary(path: string): PhotoLibrary {
  const db = new DatabaseSync(path);
  try {
    const rows = db
      .prepare(
        `SELECT a.Z_PK AS id, a.ZDIRECTORY AS dir, a.ZFILENAME AS file, a.ZKIND AS kind, a.ZKINDSUBTYPE AS subtype,
                a.ZDATECREATED AS created, a.ZDURATION AS duration, a.ZWIDTH AS width, a.ZHEIGHT AS height,
                a.ZFAVORITE AS favorite, a.ZHIDDEN AS hidden, a.ZTRASHEDSTATE AS trashed,
                x.ZORIGINALFILENAME AS original, x.ZORIGINALFILESIZE AS bytes
         FROM ZASSET a LEFT JOIN ZADDITIONALASSETATTRIBUTES x ON x.ZASSET = a.Z_PK
         WHERE a.ZDIRECTORY IS NOT NULL AND a.ZFILENAME IS NOT NULL
         ORDER BY a.ZDATECREATED DESC`,
      )
      .all() as Row[];
    const join = albumJoin(db);
    const membership = new Map<number, number[]>();
    let albums: PhotoAlbum[] = [];
    if (join) {
      for (const m of db.prepare(`SELECT ${join.album} AS album, ${join.asset} AS asset FROM ${join.table}`).all() as Row[])
        membership.set(Number(m.asset), [...(membership.get(Number(m.asset)) ?? []), Number(m.album)]);
      albums = (db.prepare(`SELECT Z_PK AS id, ZTITLE AS title FROM ZGENERICALBUM WHERE ZKIND = ${USER_ALBUM} AND COALESCE(ZTRASHEDSTATE, 0) = 0 ORDER BY ZTITLE`).all() as Row[]).map(
        (a) => ({ id: Number(a.id), title: String(a.title ?? "Untitled album"), count: 0 }),
      );
    }
    const assets: PhotoAsset[] = rows.map((r) => {
      const kind = Number(r.kind) === KIND_VIDEO ? "video" : "photo";
      return {
        id: Number(r.id),
        path: `${r.dir}/${r.file}`,
        name: String(r.original ?? r.file),
        kind,
        date: appleTime(r.created as number),
        bytes: Number(r.bytes) || undefined,
        width: Number(r.width) || undefined,
        height: Number(r.height) || undefined,
        duration: kind === "video" ? Number(r.duration) || undefined : undefined,
        live: kind === "photo" && Number(r.subtype) === SUBTYPE_LIVE,
        screenshot: kind === "photo" && Number(r.subtype) === SUBTYPE_SCREENSHOT,
        favorite: Number(r.favorite) === 1,
        hidden: Number(r.hidden) === 1,
        deleted: Number(r.trashed) === 1,
        albums: membership.get(Number(r.id)) ?? [],
      };
    });
    const live = assets.filter((a) => !a.deleted);
    for (const album of albums) album.count = live.filter((a) => a.albums.includes(album.id)).length;
    return { assets, albums, duplicates: findDuplicates(live) };
  } finally {
    db.close();
  }
}

/**
 * Likely duplicates: same file size and dimensions. ponytail: no content comparison, so two
 * different photos of identical size could pair up; add a hash of the originals if that shows up.
 */
export function findDuplicates(assets: PhotoAsset[]): number[][] {
  const groups = new Map<string, number[]>();
  for (const a of assets) {
    if (!a.bytes) continue;
    const key = `${a.kind}:${a.bytes}:${a.width}x${a.height}`;
    groups.set(key, [...(groups.get(key) ?? []), a.id]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Thumbnail file for a phone path (fetched first on Android), or undefined if there is none. */
export async function thumbnail(id: string, path: string): Promise<string | undefined> {
  // Hosts in ddthumb:// URLs arrive lowercased; match the id the library was read with.
  const deviceId = [...platforms.keys()].find((k) => k.toLowerCase() === id.toLowerCase()) ?? id;
  if (platforms.get(deviceId) === "android") {
    const asset = synced.get(deviceId)?.library.assets.find((a) => a.path === path);
    return asset && androidThumbnail(deviceId, asset, join(thumbRoot(deviceId), "android", `${asset.id}.jpg`));
  }
  const root = resolve(thumbRoot(deviceId));
  const file = resolve(root, path, THUMB_FILE);
  return file.startsWith(root + sep) ? file : undefined;
}

const COPY_CONCURRENCY = 3;

/** Copies originals of the chosen items to a folder the user picks, in a task with progress. */
export async function exportPhotos(id: string, assetIds: number[], win?: BrowserWindow) {
  const library = await known(id);
  const wanted = new Set(assetIds);
  const items = library.assets.filter((a) => wanted.has(a.id));
  if (items.length === 0) throw new Error("Nothing selected.");
  const options: Electron.OpenDialogOptions = {
    title: "Export to",
    buttonLabel: "Export here",
    defaultPath: app.getPath("pictures"),
    properties: ["openDirectory", "createDirectory"],
  };
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) return false;
  const dest = picked.filePaths[0];
  const total = items.reduce((s, i) => s + (i.bytes ?? 0), 0);

  startJob(id, `Export ${items.length} ${items.length === 1 ? "item" : "items"}`, async (report, signal) => {
    let done = 0;
    let bytes = 0;
    let skipped = 0;
    const taken = new Set<string>();
    const queue = [...items];
    const worker = async () => {
      for (let item = queue.shift(); item && !signal.aborted; item = queue.shift()) {
        // Keep the name it was taken with; add " (2)" if two items share it (IMG numbers restart).
        let name = fileSafe(item.name, "photo");
        const dot = name.lastIndexOf(".");
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${dot > 0 ? name.slice(0, dot) : name} (${n})${dot > 0 ? name.slice(dot) : ""}`;
        taken.add(name.toLowerCase());
        const local = join(dest, name);
        // Same name and size already there = exported earlier; skip so a re-run resumes.
        if ((await stat(local).catch(() => undefined))?.size === item.bytes) skipped++;
        else await copyFromPhone(id, item, local, 10 * 60_000);
        done++;
        bytes += item.bytes ?? 0;
        report({
          progress: total ? (bytes / total) * 100 : (done / items.length) * 100,
          detail: `${done} of ${items.length}${skipped ? ` (${skipped} already there)` : ""} · ${item.name}`,
        });
      }
    };
    await Promise.all(Array.from({ length: COPY_CONCURRENCY }, worker));
    return dest;
  });
  return true;
}

/** Viewable local copies of originals, by previewKey. URL hosts arrive lowercased, so the device id is too. */
const previewKey = (id: string, phonePath: string) => `${id.toLowerCase()}/${phonePath}`;
const previews = new Map<string, string>();
const preparing = new Map<string, Promise<void>>();

async function findAsset(id: string, assetId: number): Promise<PhotoAsset> {
  const asset = (await known(id)).assets.find((a) => a.id === assetId);
  if (!asset) throw new Error("This item is no longer on the iPhone. Refresh and try again.");
  return asset;
}

/**
 * Copies one original from the phone and makes it viewable: HEIC becomes JPEG (Chromium can't show
 * HEIC), videos are rewrapped as MP4 without re-encoding. Show it with mediaUrl(device, asset.path).
 */
export async function prepareMedia(id: string, assetId: number): Promise<void> {
  const asset = await findAsset(id, assetId);
  const key = previewKey(id, asset.path);
  if (previews.has(key)) return;
  const running = preparing.get(key);
  if (running) return running;
  const work = (async () => {
    const dir = join(workDir(), "preview", id);
    await mkdir(dir, { recursive: true });
    const ext = extname(asset.path).toLowerCase();
    const original = join(dir, `${asset.id}${ext}`);
    await copyFromPhone(id, asset, original, 10 * 60_000).catch(() => {
      throw new Error(platforms.get(id) === "android" ? "Couldn't copy this item from the phone." : "The original isn't on the iPhone (it may be stored only in iCloud).");
    });
    let shown = original;
    if (ext === ".heic" || ext === ".heif") {
      shown = join(dir, `${asset.id}.jpg`);
      if (process.platform === "darwin") await run("sips", ["-s", "format", "jpeg", original, "--out", shown], { timeoutMs: 60_000 });
      else await run("ffmpeg", ["-y", "-v", "error", "-i", original, "-filter_complex", "[0:g:0]", "-frames:v", "1", shown], { timeoutMs: 60_000 });
    } else if (asset.kind === "video" && ext !== ".mp4") {
      const mp4 = join(dir, `${asset.id}.mp4`);
      // Rewrapping only; if ffmpeg is missing or can't, the original may still play.
      shown = await run("ffmpeg", ["-y", "-v", "error", "-i", original, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", mp4], { timeoutMs: 5 * 60_000 }).then(
        () => mp4,
        () => original,
      );
    }
    previews.set(key, shown);
  })().finally(() => preparing.delete(key));
  preparing.set(key, work);
  return work;
}

/** Local viewable copy for ddthumb://<device>/__full/<phone path>, once prepared. */
export const previewFile = (id: string, phonePath: string) => previews.get(previewKey(id, phonePath));

/** What the camera protocol identifies an item by: original size and extension (its names are made up). */
const mediaKey = (a: PhotoAsset) => (a.bytes ? `${a.bytes}:${extname(a.path).slice(1).toLowerCase()}` : undefined);

/**
 * Deletes items from the phone, asking first; undefined = declined.
 * Android: moved to the phone's own Trash (the Gallery keeps them ~30 days and can restore them).
 * iPhone: through the camera protocol (ImageCaptureCore), so the Photos app removes them itself.
 * ponytail: the iPhone path is macOS only; Windows would use the same protocol through WPD.
 */
export async function deletePhotos(id: string, assetIds: number[], win?: BrowserWindow): Promise<PhotoDeleteResult | undefined> {
  const android = platforms.get(id) === "android";
  if (!android && process.platform !== "darwin") throw new Error("Deleting photos works on Mac for now.");
  const library = await known(id);
  const wanted = new Set(assetIds);
  const items = library.assets.filter((a) => wanted.has(a.id) && !a.deleted);
  if (items.length === 0) throw new Error("Nothing selected.");
  const noun = items.length === 1 ? "item" : `${items.length} items`;
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    buttons: [`Delete ${noun}`, "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Delete ${noun} from the phone?`,
    detail: android
      ? "They go to the phone's own Trash, where the Gallery keeps them about 30 days before removing them for good."
      : "The iPhone's Photos app removes them. Export anything you want to keep first.",
  };
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (response !== 0) return undefined;

  if (android) {
    const result = await androidTrash(id, items);
    synced.delete(id); // the next read drops the trashed items
    return { ...result, notOnPhone: 0 };
  }

  // A key shared by two library items can't say which one is meant; leave those alone.
  const count = new Map<string, number>();
  for (const a of library.assets) {
    const k = mediaKey(a);
    if (k && !a.deleted) count.set(k, (count.get(k) ?? 0) + 1);
  }
  const keys = items.map(mediaKey).filter((k): k is string => !!k && count.get(k) === 1);
  const result: PhotoDeleteResult = { deleted: 0, notOnPhone: 0, skipped: items.length - keys.length };
  if (keys.length > 0) {
    const out = await run("ddphotos", [id, "delete", ...keys], { timeoutMs: 10 * 60_000 });
    for (const line of out.split("\n")) {
      const word = line.split(" ")[0];
      if (word === "deleted") result.deleted++;
      else if (word === "missing") result.notOnPhone++;
      else if (word === "ambiguous" || word === "failed") result.skipped++;
    }
  }
  synced.delete(id); // the next read picks up the change
  return result;
}
