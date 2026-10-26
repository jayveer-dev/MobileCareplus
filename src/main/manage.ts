import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserWindow, dialog } from "electron";
import type { AppInfo, Platform } from "../shared/types";
import { androidAppIcons, androidIconFile } from "./androidIcons";
import { workDir } from "./backupSource";
import { run, ToolError } from "./tools";

const ask = (win: BrowserWindow | undefined, options: Electron.MessageBoxOptions) =>
  win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);

// Home and storage both need the app list, and the iPhone query takes seconds: share one answer briefly.
const APPS_TTL_MS = 30_000;
const appsCache = new Map<string, { at: number; apps: Promise<AppInfo[]> }>();

export function listApps(platform: Platform, id: string): Promise<AppInfo[]> {
  const hit = appsCache.get(id);
  if (hit && Date.now() - hit.at < APPS_TTL_MS) return hit.apps;
  const apps = queryApps(platform, id);
  appsCache.set(id, { at: Date.now(), apps });
  apps.catch(() => appsCache.delete(id));
  return apps;
}

async function queryApps(platform: Platform, id: string): Promise<AppInfo[]> {
  if (platform === "android") {
    // -3 = apps the user installed; system apps can't be removed without root.
    const out = await run("adb", ["-s", id, "shell", "pm", "list", "packages", "-3"]);
    return out
      .split(/\r?\n/)
      .map((l) => l.replace(/^package:/, "").trim())
      .filter(Boolean)
      .map((pkg) => ({ id: pkg, name: pkg }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const xml = await run(
    "ideviceinstaller",
    ["-u", id, "list", "--user", "--xml", ...["CFBundleIdentifier", "CFBundleDisplayName", "CFBundleName", "CFBundleShortVersionString", "StaticDiskUsage", "DynamicDiskUsage"].flatMap((a) => ["-a", a])],
    { timeoutMs: 60_000 },
  );
  const json = await run("plistutil", ["-i", "-", "-f", "json", "-C"], { input: xml });
  const entries = JSON.parse(json) as Record<string, string | number | undefined>[];
  return entries
    .map((e) => ({
      id: String(e.CFBundleIdentifier),
      name: String(e.CFBundleDisplayName || e.CFBundleName || e.CFBundleIdentifier),
      version: e.CFBundleShortVersionString === undefined ? undefined : String(e.CFBundleShortVersionString),
      appBytes: typeof e.StaticDiskUsage === "number" ? e.StaticDiskUsage : undefined,
      dataBytes: typeof e.DynamicDiskUsage === "number" ? e.DynamicDiskUsage : undefined,
    }))
    .sort((a, b) => (b.appBytes ?? 0) + (b.dataBytes ?? 0) - (a.appBytes ?? 0) - (a.dataBytes ?? 0));
}

export async function uninstallApp(platform: Platform, id: string, target: { id: string; name: string }, win?: BrowserWindow) {
  const { response } = await ask(win, {
    type: "warning",
    buttons: ["Uninstall", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Uninstall ${target.name}?`,
    detail: "The app and everything stored in it are removed from the phone. Data synced to the app's own account stays there.",
  });
  if (response !== 0) return false;
  appsCache.delete(id);
  if (platform === "android") {
    const out = await run("adb", ["-s", id, "uninstall", target.id], { timeoutMs: 120_000 });
    if (!/Success/.test(out)) throw new Error(out.trim() || "The phone refused to uninstall the app.");
  } else {
    await run("ideviceinstaller", ["-u", id, "uninstall", target.id], { timeoutMs: 120_000 });
  }
  return true;
}

const ICON_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
export const iconDir = (id: string) => join(workDir(), "icons", id);

/**
 * Fetches home-screen icons for apps not cached yet; returns the ids that have an icon.
 * iPhone: one connection (native/ddicons.c). Android: from each app's package (androidIcons.ts).
 */
export async function appIcons(platform: Platform, id: string, bundleIds: string[]): Promise<string[]> {
  if (platform === "android") return androidAppIcons(id, bundleIds.filter((b) => ICON_ID.test(b)));
  const dir = iconDir(id);
  await mkdir(dir, { recursive: true });
  const have = new Set((await readdir(dir)).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4)));
  const missing = bundleIds.filter((b) => ICON_ID.test(b) && !have.has(b));
  if (missing.length) {
    const out = await run("ddicons", [id, dir, ...missing], { timeoutMs: 120_000 }).catch((e: unknown) => (e instanceof ToolError ? e.output : ""));
    for (const line of out.split(/\r?\n/)) if (line.startsWith("ok ")) have.add(line.slice(3).trim());
  }
  return bundleIds.filter((b) => have.has(b));
}

/** Path of a cached icon file, or undefined if there's none or the id isn't safe. */
export async function iconFile(id: string, bundleId: string): Promise<string | undefined> {
  if (!ICON_ID.test(bundleId)) return undefined;
  return (await androidIconFile(bundleId)) ?? join(iconDir(id), `${bundleId}.png`);
}

/** One confirmation for several apps, then removes them one by one; returns how many were removed. */
export async function uninstallApps(platform: Platform, id: string, targets: { id: string; name: string }[], win?: BrowserWindow): Promise<number> {
  if (targets.length === 1) return (await uninstallApp(platform, id, targets[0], win)) ? 1 : 0;
  const { response } = await ask(win, {
    type: "warning",
    buttons: [`Uninstall ${targets.length} apps`, "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Uninstall ${targets.length} apps?`,
    detail: `${targets.map((t) => t.name).slice(0, 12).join(", ")}${targets.length > 12 ? `, and ${targets.length - 12} more` : ""}.\n\nThe apps and everything stored in them are removed from the phone.`,
  });
  if (response !== 0) return 0;
  appsCache.delete(id);
  let removed = 0;
  for (const t of targets) {
    if (platform === "android") {
      const out = await run("adb", ["-s", id, "uninstall", t.id], { timeoutMs: 120_000 });
      if (!/Success/.test(out)) throw new Error(`${t.name}: ${out.trim() || "the phone refused to uninstall it."}`);
    } else await run("ideviceinstaller", ["-u", id, "uninstall", t.id], { timeoutMs: 120_000 });
    removed++;
  }
  return removed;
}
