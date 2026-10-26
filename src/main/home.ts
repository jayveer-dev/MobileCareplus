// Home page data and the restart / shut down controls.
import { type BrowserWindow, dialog } from "electron";
import type { Battery, HomeSummary, PhotoAsset, Platform } from "../shared/types";
import { listContacts, listConversations } from "./backupData";
import { listBackups } from "./backups";
import { personalData } from "./lightLoad";
import { isUnlocked } from "./backupSource";
import { listApps } from "./manage";
import { photoLibrary } from "./photoLibrary";
import { batteryHealth, modelName, parseGetprop, parseKeyValues } from "./parse";
import { run } from "./tools";

// Android BatteryManager.BATTERY_HEALTH_* codes.
const ANDROID_HEALTH: Record<string, string> = { "2": "Good", "3": "Overheating", "4": "Worn out", "5": "Over voltage", "6": "Faulty", "7": "Too cold" };

async function iosBattery(id: string): Promise<Battery> {
  const level = Number(parseKeyValues(await run("ideviceinfo", ["-u", id, "-q", "com.apple.mobile.battery"])).BatteryCurrentCapacity);
  let extra = {};
  try {
    const xml = await run("idevicediagnostics", ["-u", id, "ioregentry", "AppleSmartBattery"]);
    const json = JSON.parse(await run("plistutil", ["-i", "-", "-f", "json", "-C"], { input: xml })) as { IORegistry?: Record<string, unknown> };
    extra = batteryHealth(json.IORegistry ?? {});
  } catch {
    // Some iOS versions refuse the registry query; level alone is still useful.
  }
  return { level: Number.isFinite(level) ? level : undefined, ...extra };
}

async function androidBattery(id: string): Promise<Battery> {
  const dump = await run("adb", ["-s", id, "shell", "dumpsys", "battery"]);
  const field = (k: string) => dump.match(new RegExp(`^\\s*${k}: (\\S+)`, "m"))?.[1];
  return {
    level: Number(field("level")) || undefined,
    condition: ANDROID_HEALTH[field("health") ?? ""],
    charging: field("status") === "2",
  };
}

/** What the Photos app shows: not deleted, not hidden. Newest first, as the library is sorted. */
function photoSummary(assets: PhotoAsset[]) {
  const shown = assets.filter((a) => !a.deleted && !a.hidden);
  return {
    count: shown.length,
    bytes: shown.reduce((s, a) => s + (a.bytes ?? 0), 0),
    recent: shown.filter((a) => a.kind === "photo").slice(0, 3).map((a) => a.path),
  };
}

const settled = async <T>(p: Promise<T>) => p.then((v) => v, () => undefined);

export async function homeSummary(platform: Platform, id: string): Promise<HomeSummary> {
  if (platform === "android") {
    const [props, battery, apps, library] = await Promise.all([
      settled(run("adb", ["-s", id, "shell", "getprop"]).then(parseGetprop)),
      settled(androidBattery(id)),
      settled(listApps("android", id)),
      settled(photoLibrary("android", id)),
    ]);
    return {
      modelName: props && [props["ro.product.manufacturer"], props["ro.product.model"]].filter(Boolean).join(" "),
      osVersion: props?.["ro.build.version.release"] && `Android ${props["ro.build.version.release"]}`,
      battery,
      photos: library && photoSummary(library.assets),
      apps: apps && { count: apps.length },
    };
  }
  const [info, battery, library, apps, backup] = await Promise.all([
    settled(run("ideviceinfo", ["-u", id]).then(parseKeyValues)),
    settled(iosBattery(id)),
    settled(photoLibrary("ios", id)),
    settled(listApps("ios", id)),
    settled(listBackups().then((all) => all.find((b) => b.sourceId === id))),
  ]);
  // Counts come from the personal-data load (Load from iPhone), when it has been loaded and is readable.
  const cache = await settled(personalData(id));
  const readable = cache && (!cache.encrypted || isUnlocked(cache.sourceId));
  const [contacts, conversations] = readable ? await Promise.all([settled(listContacts(cache.sourceId)), settled(listConversations(cache.sourceId))]) : [];
  return {
    modelName: modelName(info?.ProductType),
    osVersion: info?.ProductVersion && `iOS ${info.ProductVersion}`,
    battery,
    photos: library && photoSummary(library.assets),
    apps: apps && {
      count: apps.length,
      bytes: apps.reduce((s, a) => s + (a.appBytes ?? 0) + (a.dataBytes ?? 0), 0),
      // listApps is already sorted biggest first.
      largest: apps.slice(0, 3).map((a) => ({ name: a.name, bytes: (a.appBytes ?? 0) + (a.dataBytes ?? 0) })),
    },
    contacts: contacts?.length,
    conversations: conversations?.length,
    lastBackup: backup && { date: backup.date, encrypted: backup.encrypted, locked: backup.encrypted && !isUnlocked(id) },
  };
}

export async function power(platform: Platform, id: string, action: "restart" | "shutdown", win?: BrowserWindow) {
  const options: Electron.MessageBoxOptions = {
    type: "question",
    buttons: [action === "restart" ? "Restart" : "Shut down", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: action === "restart" ? "Restart the phone?" : "Shut down the phone?",
    detail: action === "restart" ? "It disconnects for about a minute while it starts again." : "You'll need to turn it back on with its side button.",
  };
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (response !== 0) return false;
  if (platform === "ios") await run("idevicediagnostics", ["-u", id, action]);
  else await run("adb", action === "restart" ? ["-s", id, "reboot"] : ["-s", id, "shell", "reboot", "-p"]);
  return true;
}
