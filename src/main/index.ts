import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, net, protocol, shell } from "electron";
// Installed builds keep everything in one folder named after the product (development uses the
// package name). Set before anything reads userData.
if (app.isPackaged) app.setPath("userData", join(app.getPath("appData"), "Mobile Care Plus"));
import type { Platform, SaveType } from "../shared/types";
import { backupContents, backupEncryption, listBackups, removeBackup, restoreBackup, revealBackup, setBackupEncryption, startBackup } from "./backups";
import { clearBackupCopies, isUnlocked, unlockBackup } from "./backupSource";
import { exportContacts, exportConversation, listContacts, listConversations, listMessages } from "./backupData";
import { homeSummary, power } from "./home";
import { loadPersonalData, personalData } from "./lightLoad";
import { appIcons, iconFile, listApps, uninstallApps } from "./manage";
import { deletePhotos, exportPhotos, photoLibrary, prepareMedia, previewFile, thumbnail } from "./photoLibrary";
import { assertDeviceId, deviceInfo, listDevices, pair, storage } from "./devices";
import { type AndroidSaveType, androidSaveCounts, listAndroidSaves, restoreAndroidSave, revealAndroidSave, saveAndroidSelected } from "./androidSave";
import { SAVE_TYPES, pickSaveFolder, saveFolder, saveSelected } from "./selective";
import { parseByteRange } from "./parse";
import { screenshot } from "./toolbox";
import { openTransfer } from "./transfer";
import { cancelAll, cancelTask, listTasks, onTasksChanged, taskResult } from "./tasks";

function assertPlatform(p: unknown): asserts p is Platform {
  if (p !== "ios" && p !== "android") throw new Error("Invalid platform");
}

function assertPassword(p: unknown): asserts p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 256) throw new Error("Invalid password");
}

ipcMain.handle("devices:list", () => listDevices());
ipcMain.handle("devices:info", (_e, platform: unknown, id: unknown) => {
  assertPlatform(platform);
  assertDeviceId(id);
  return deviceInfo(platform, id);
});
ipcMain.handle("devices:storage", (_e, platform: unknown, id: unknown) => {
  assertPlatform(platform);
  assertDeviceId(id);
  return storage(platform, id);
});
ipcMain.handle("devices:summary", (_e, platform: unknown, id: unknown) => {
  assertPlatform(platform);
  assertDeviceId(id);
  return homeSummary(platform, id);
});
ipcMain.handle("devices:power", (e, platform: unknown, id: unknown, action: unknown) => {
  assertPlatform(platform);
  assertDeviceId(id);
  if (action !== "restart" && action !== "shutdown") throw new Error("Invalid action");
  return power(platform, id, action, BrowserWindow.fromWebContents(e.sender) ?? undefined);
});
ipcMain.handle("devices:pair", (_e, platform: unknown, id: unknown) => {
  assertPlatform(platform);
  assertDeviceId(id);
  return pair(platform, id);
});

ipcMain.handle("backups:list", () => listBackups());
ipcMain.handle("backups:personalData", async (_e, id: unknown) => {
  assertDeviceId(id);
  return (await personalData(id)) ?? null;
});
ipcMain.handle("backups:loadPersonalData", (_e, id: unknown) => {
  assertDeviceId(id);
  return loadPersonalData(id);
});
ipcMain.handle("backups:contents", (_e, sourceId: unknown) => {
  assertDeviceId(sourceId);
  return backupContents(sourceId);
});
ipcMain.handle("backups:start", (_e, id: unknown) => {
  assertDeviceId(id);
  return startBackup(id);
});
ipcMain.handle("backups:restore", (e, id: unknown, options: unknown) => {
  assertDeviceId(id);
  const { sourceId, password } = (options ?? {}) as Record<string, unknown>;
  assertDeviceId(sourceId);
  if (password !== undefined) assertPassword(password);
  return restoreBackup(id, { sourceId, password }, BrowserWindow.fromWebContents(e.sender) ?? undefined);
});
ipcMain.handle("backups:encryption", (_e, id: unknown) => {
  assertDeviceId(id);
  return backupEncryption(id);
});
ipcMain.handle("backups:setEncryption", (_e, id: unknown, on: unknown, password: unknown) => {
  assertDeviceId(id);
  assertPassword(password);
  return setBackupEncryption(id, on === true, password);
});
ipcMain.handle("backups:remove", (e, sourceId: unknown) => {
  assertDeviceId(sourceId);
  return removeBackup(sourceId, BrowserWindow.fromWebContents(e.sender) ?? undefined);
});
ipcMain.handle("backups:reveal", (_e, sourceId: unknown) => {
  assertDeviceId(sourceId);
  revealBackup(sourceId);
});

function assertAppId(a: unknown): asserts a is string {
  if (typeof a !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(a)) throw new Error("Invalid app id");
}

ipcMain.handle("manage:apps", (_e, platform: unknown, id: unknown) => {
  assertPlatform(platform);
  assertDeviceId(id);
  return listApps(platform, id);
});
ipcMain.handle("manage:uninstall", (e, platform: unknown, id: unknown, targets: unknown) => {
  assertPlatform(platform);
  assertDeviceId(id);
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 1000) throw new Error("Invalid selection");
  const clean = targets.map((t) => {
    const { id: appId, name } = (t ?? {}) as Record<string, unknown>;
    assertAppId(appId);
    return { id: appId, name: typeof name === "string" ? name.slice(0, 200) : appId };
  });
  return uninstallApps(platform, id, clean, BrowserWindow.fromWebContents(e.sender) ?? undefined);
});
ipcMain.handle("manage:appIcons", (_e, platform: unknown, id: unknown, bundleIds: unknown) => {
  assertPlatform(platform);
  assertDeviceId(id);
  if (!Array.isArray(bundleIds) || bundleIds.length > 2000) throw new Error("Invalid apps");
  return appIcons(platform, id, bundleIds.filter((b): b is string => typeof b === "string"));
});
const ANDROID_SAVE: AndroidSaveType[] = ["photos", "contacts", "calendars"];
ipcMain.handle("backups:androidCounts", (_e, id: unknown) => {
  assertDeviceId(id);
  return androidSaveCounts(id);
});
ipcMain.handle("backups:saveAndroid", (_e, id: unknown, name: unknown, types: unknown) => {
  assertDeviceId(id);
  const clean = (Array.isArray(types) ? types : []).filter((t): t is AndroidSaveType => ANDROID_SAVE.includes(t as AndroidSaveType));
  if (clean.length === 0) throw new Error("Choose at least one type.");
  return saveAndroidSelected(id, typeof name === "string" && name.trim() ? name.slice(0, 100) : "Android phone", clean);
});
const assertDir = (d: unknown): string => {
  if (typeof d !== "string" || !d) throw new Error("Invalid folder");
  return d;
};
ipcMain.handle("backups:androidSaves", () => listAndroidSaves());
ipcMain.handle("backups:revealAndroidSave", (_e, dir: unknown) => revealAndroidSave(assertDir(dir)));
ipcMain.handle("backups:restoreAndroidSave", (e, dir: unknown, id: unknown, name: unknown) => {
  assertDeviceId(id);
  return restoreAndroidSave(assertDir(dir), id, typeof name === "string" && name.trim() ? name.slice(0, 100) : "Android phone", BrowserWindow.fromWebContents(e.sender) ?? undefined);
});
ipcMain.handle("manage:photoLibrary", (_e, platform: unknown, id: unknown) => {
  assertPlatform(platform);
  assertDeviceId(id);
  return photoLibrary(platform, id);
});
ipcMain.handle("manage:exportPhotos", (e, id: unknown, assetIds: unknown) => {
  assertDeviceId(id);
  if (!Array.isArray(assetIds) || assetIds.length > 1_000_000 || !assetIds.every((n) => Number.isSafeInteger(n))) throw new Error("Invalid selection");
  return exportPhotos(id, assetIds as number[], BrowserWindow.fromWebContents(e.sender) ?? undefined);
});

ipcMain.handle("manage:previewMedia", (_e, id: unknown, assetId: unknown) => {
  assertDeviceId(id);
  if (!Number.isSafeInteger(assetId)) throw new Error("Invalid item");
  return prepareMedia(id, assetId as number);
});
ipcMain.handle("manage:deletePhotos", (e, id: unknown, assetIds: unknown) => {
  assertDeviceId(id);
  if (!Array.isArray(assetIds) || assetIds.length > 100_000 || !assetIds.every((n) => Number.isSafeInteger(n))) throw new Error("Invalid selection");
  return deletePhotos(id, assetIds as number[], BrowserWindow.fromWebContents(e.sender) ?? undefined);
});

function assertChatId(c: unknown): asserts c is number {
  if (!Number.isSafeInteger(c) || (c as number) < 0) throw new Error("Invalid conversation");
}

ipcMain.handle("manage:contacts", (_e, sourceId: unknown) => {
  assertDeviceId(sourceId);
  return listContacts(sourceId);
});
ipcMain.handle("manage:exportContacts", (e, sourceId: unknown, format: unknown) => {
  assertDeviceId(sourceId);
  if (format !== "vcf" && format !== "csv") throw new Error("Invalid format");
  return exportContacts(sourceId, format, BrowserWindow.fromWebContents(e.sender) ?? undefined);
});
ipcMain.handle("manage:conversations", (_e, sourceId: unknown) => {
  assertDeviceId(sourceId);
  return listConversations(sourceId);
});
ipcMain.handle("manage:messages", (_e, sourceId: unknown, chatId: unknown) => {
  assertDeviceId(sourceId);
  assertChatId(chatId);
  return listMessages(sourceId, chatId);
});
ipcMain.handle("manage:exportConversation", (e, sourceId: unknown, chatId: unknown) => {
  assertDeviceId(sourceId);
  assertChatId(chatId);
  return exportConversation(sourceId, chatId, BrowserWindow.fromWebContents(e.sender) ?? undefined);
});

ipcMain.handle("backups:saveFolder", () => saveFolder());
ipcMain.handle("backups:pickSaveFolder", (e) => pickSaveFolder(BrowserWindow.fromWebContents(e.sender) ?? undefined));
ipcMain.handle("backups:unlock", (_e, sourceId: unknown, password: unknown) => {
  assertDeviceId(sourceId);
  assertPassword(password);
  return unlockBackup(sourceId, password);
});
ipcMain.handle("backups:isUnlocked", (_e, sourceId: unknown) => {
  assertDeviceId(sourceId);
  return isUnlocked(sourceId);
});
ipcMain.handle("backups:saveSelected", (_e, id: unknown, types: unknown, password: unknown) => {
  assertDeviceId(id);
  if (password !== undefined) assertPassword(password);
  if (!Array.isArray(types) || types.length === 0) throw new Error("Choose at least one type to save.");
  // Keep the fixed order (and drop duplicates/unknowns) whatever order the boxes were ticked in.
  return saveSelected(id, SAVE_TYPES.filter((t) => types.includes(t)) as SaveType[], password);
});

ipcMain.handle("modules:openTransfer", () => openTransfer());
ipcMain.handle("tools:screenshot", (_e, platform: unknown, id: unknown, name: unknown) => {
  assertPlatform(platform);
  assertDeviceId(id);
  return screenshot(platform, id, typeof name === "string" && name.trim() ? name.slice(0, 100) : "Phone");
});

ipcMain.handle("tasks:list", () => listTasks());
ipcMain.handle("tasks:reveal", (_e, id: unknown) => {
  const path = typeof id === "number" ? taskResult(id) : undefined;
  if (path) shell.showItemInFolder(path);
});
ipcMain.handle("tasks:cancel", (_e, id: unknown) => {
  if (typeof id === "number") cancelTask(id);
});
onTasksChanged((tasks) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("tasks:update", tasks);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 900,
    minHeight: 620,
    title: "Mobile Care Plus",
    webPreferences: { preload: join(__dirname, "../preload/index.js"), contextIsolation: true, sandbox: true },
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, "../renderer/index.html"));
}

const MEDIA_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif" };

/** A local file with Range support, so videos can seek (file fetches through a custom scheme can't). */
async function fileResponse(file: string, rangeHeader: string | null): Promise<Response> {
  const { size } = await stat(file);
  const headers: Record<string, string> = { "Accept-Ranges": "bytes" };
  const type = MEDIA_TYPES[extname(file).toLowerCase()];
  if (type) headers["Content-Type"] = type;
  const range = parseByteRange(rangeHeader, size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
  headers["Content-Length"] = String(end - start + 1);
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status: range ? 206 : 200, headers });
}

// Photo thumbnails and app icons come from local copies: ddthumb://<device>/<phone path> or /__icon/<bundle id>.
protocol.registerSchemesAsPrivileged([{ scheme: "ddthumb", privileges: { standard: true, secure: true, stream: true } }]);

app.whenReady().then(() => {
  protocol.handle("ddthumb", async (request) => {
    const url = new URL(request.url);
    const device = decodeURIComponent(url.hostname);
    const phonePath = url.pathname.split("/").filter(Boolean).map(decodeURIComponent).join("/");
    const validDevice = /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,127}$/.test(device);
    // ddthumb://<device>/__icon/<bundle id> = app icon; /__full/<path> = prepared original; else thumbnail.
    const icon = phonePath.startsWith("__icon/") ? phonePath.slice(7) : undefined;
    const full = phonePath.startsWith("__full/") ? phonePath.slice(7) : undefined;
    const file = !validDevice ? undefined : icon !== undefined ? await iconFile(device, icon) : full !== undefined ? previewFile(device, full) : await thumbnail(device, phonePath);
    if (!file) return new Response("Not found", { status: 404 });
    return full !== undefined ? fileResponse(file, request.headers.get("range")) : net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
app.on("will-quit", () => {
  cancelAll();
  void clearBackupCopies();
});
