import { join } from "node:path";
// Mobile Care Plus Transfer module: its own window and IPC; devices and tasks come from the main app's handlers.
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { isUnlocked, unlockBackup } from "./backupSource";
import { assertDeviceId } from "./devices";
import { moveCalendar, moveContacts, movePhotos, type Phone, switchSummary } from "./phoneSwitch";
import { loadPersonalData, personalData } from "./lightLoad";
import { startJob } from "./tasks";
import { type AndroidChatSource, androidChats, androidMessages, exportAndroidChats, openAndroidChats } from "./androidChats";
import { androidWhatsApp, saveAndroidWhatsApp } from "./androidWhatsApp";
import { type ChatApp, exportWhatsApp, hasLoadedWhatsApp, listSavedWhatsApp, saveWhatsAppBackup, type WaApp, type WaSource, waChats, waMessages } from "./whatsapp";

const assertApp = (a: unknown): WaApp => {
  if (a !== "whatsapp" && a !== "business") throw new Error("Unsupported app");
  return a;
};
const appName = (a: ChatApp) => (a === "business" ? "WhatsApp Business" : a === "gbwhatsapp" ? "GBWhatsApp" : "WhatsApp");
const assertChatApp = (a: unknown): ChatApp => (a === "gbwhatsapp" ? a : assertApp(a));
const assertPassword = (p: unknown): string => {
  if (typeof p !== "string" || p.length === 0 || p.length > 256) throw new Error("Invalid password");
  return p;
};
/** Sources come from the renderer: a loaded cache by device id, or a saved backup by its folder from our own list. */
async function source(raw: unknown, appId: WaApp): Promise<WaSource> {
  const s = (raw ?? {}) as Record<string, unknown>;
  if (s.kind === "loaded") {
    assertDeviceId(s.deviceId);
    return { kind: "loaded", sourceId: `cache:${s.deviceId}` };
  }
  if (s.kind === "saved" && typeof s.dir === "string") {
    // Android backups stay encrypted with the user's key, so only iPhone ones can be read here.
    const known = await listSavedWhatsApp(appId);
    if (known.some((b) => b.dir === s.dir && b.platform === "ios")) return { kind: "saved", dir: s.dir };
  }
  throw new Error("Unknown backup");
}

ipcMain.handle("data:status", async (_e, deviceId: unknown) => {
  assertDeviceId(deviceId);
  const cache = await personalData(deviceId);
  if (!cache) return null;
  const unlocked = !cache.encrypted || isUnlocked(cache.sourceId);
  return {
    date: cache.date,
    encrypted: cache.encrypted,
    unlocked,
    // Which chat apps the load found; only knowable once readable.
    apps: unlocked ? { whatsapp: await hasLoadedWhatsApp(cache.sourceId, "whatsapp"), business: await hasLoadedWhatsApp(cache.sourceId, "business") } : undefined,
  };
});
ipcMain.handle("data:load", (_e, deviceId: unknown) => {
  assertDeviceId(deviceId);
  return loadPersonalData(deviceId);
});
ipcMain.handle("data:unlock", (_e, deviceId: unknown, password: unknown) => {
  assertDeviceId(deviceId);
  return unlockBackup(`cache:${deviceId}`, assertPassword(password));
});

ipcMain.handle("wa:saved", (_e, appId: unknown) => listSavedWhatsApp(assertChatApp(appId)));
ipcMain.handle("wa:android", (_e, appId: unknown, deviceId: unknown) => {
  assertDeviceId(deviceId);
  return androidWhatsApp(deviceId, assertChatApp(appId));
});
ipcMain.handle("wa:androidBackup", (_e, appId: unknown, deviceId: unknown, deviceName: unknown) => {
  const a = assertChatApp(appId);
  assertDeviceId(deviceId);
  const name = typeof deviceName === "string" ? deviceName.slice(0, 100) : "Android phone";
  startJob(deviceId, `Back up ${appName(a)}`, (report, signal) =>
    saveAndroidWhatsApp(deviceId, a, name, signal, (detail, progress) => report({ detail, progress })),
  );
});
const androidToken = (src: unknown) => {
  const s = (src ?? {}) as Record<string, unknown>;
  return s.kind === "android" && typeof s.token === "string" ? s.token : undefined;
};
ipcMain.handle("wa:androidOpen", (_e, appId: unknown, src: unknown, key: unknown) => {
  const s = (src ?? {}) as Record<string, unknown>;
  if (typeof key !== "string" || key.length > 200) throw new Error("Invalid key");
  let source: AndroidChatSource;
  if (s.kind === "phone") {
    assertDeviceId(s.deviceId);
    source = { kind: "phone", deviceId: s.deviceId };
  } else if (s.kind === "saved" && typeof s.dir === "string") source = { kind: "saved", dir: s.dir };
  else throw new Error("Unknown backup");
  return openAndroidChats(assertChatApp(appId), source, key);
});
ipcMain.handle("wa:chats", async (_e, appId: unknown, src: unknown) => {
  const token = androidToken(src);
  if (token) return androidChats(token);
  const a = assertApp(appId);
  return waChats(await source(src, a), a);
});
ipcMain.handle("wa:messages", async (_e, appId: unknown, src: unknown, chatId: unknown) => {
  const a = assertApp(appId);
  if (!Number.isSafeInteger(chatId)) throw new Error("Invalid chat");
  const token = androidToken(src);
  if (token) return androidMessages(token, chatId as number);
  return waMessages(await source(src, a), a, chatId as number);
});
ipcMain.handle("wa:backup", (_e, appId: unknown, deviceId: unknown, deviceName: unknown) => {
  const a = assertApp(appId);
  assertDeviceId(deviceId);
  const name = typeof deviceName === "string" ? deviceName.slice(0, 100) : "iPhone";
  startJob(deviceId, `Back up ${appName(a)}`, async (report, signal) =>
    saveWhatsAppBackup(`cache:${deviceId}`, a, name, signal, (done, total) => report({ progress: (done / total) * 100, detail: `${done} of ${total} media files` })),
  );
});
ipcMain.handle("wa:export", async (e, appId: unknown, src: unknown, deviceId: unknown) => {
  const token = androidToken(src);
  const a = token ? assertChatApp(appId) : assertApp(appId);
  assertDeviceId(deviceId);
  const from = token ? undefined : await source(src, a as WaApp);
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const options: Electron.OpenDialogOptions = { title: "Export chats to", buttonLabel: "Export here", defaultPath: app.getPath("documents"), properties: ["openDirectory", "createDirectory"] };
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) return false;
  const dest = join(picked.filePaths[0], `${appName(a)} ${new Date().toISOString().slice(0, 10)}`);
  startJob(deviceId, `Export ${appName(a)} chats`, async (report, signal) => {
    const onChat = (done: number, total: number) => report({ progress: (done / total) * 100, detail: `${done} of ${total} chats` });
    if (token) return exportAndroidChats(token, dest, signal, onChat);
    await exportWhatsApp(from!, a as WaApp, dest, signal, onChat);
    return dest;
  });
  return true;
});

/** A phone as the renderer describes it; the name is only used for labels and the album name. */
function phone(raw: unknown): Phone {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (p.platform !== "ios" && p.platform !== "android") throw new Error("Invalid phone");
  assertDeviceId(p.id);
  return { platform: p.platform, id: p.id, name: typeof p.name === "string" && p.name.trim() ? p.name.slice(0, 100) : "Old phone" };
}
ipcMain.handle("switch:summary", (_e, source: unknown) => switchSummary(phone(source)));
const MOVERS = { photos: movePhotos, contacts: moveContacts, calendar: moveCalendar } as const;
ipcMain.handle("switch:move", async (_e, what: unknown, source: unknown, dest: unknown) => {
  const kinds = (Array.isArray(what) ? what : []).filter((k): k is keyof typeof MOVERS => typeof k === "string" && k in MOVERS);
  if (kinds.length === 0) throw new Error("Nothing chosen.");
  const from = phone(source);
  const to = phone(dest);
  if (from.id === to.id) throw new Error("Choose two different phones.");
  for (const kind of kinds) await MOVERS[kind](from, to);
});

let transferWindow: BrowserWindow | undefined;

/** Opens the Transfer window, or brings it to the front if it's already open. */
export function openTransfer() {
  if (transferWindow && !transferWindow.isDestroyed()) {
    if (transferWindow.isMinimized()) transferWindow.restore();
    transferWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 860,
    minHeight: 600,
    title: "Mobile Care Plus Transfer",
    webPreferences: { preload: join(__dirname, "../preload/transfer.js"), contextIsolation: true, sandbox: true },
  });
  transferWindow = win;
  win.on("closed", () => (transferWindow = undefined));
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/transfer.html`);
  else win.loadFile(join(__dirname, "../renderer/transfer.html"));
}
