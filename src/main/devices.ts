import type { Device, DeviceInfo, DeviceListResult, Platform, StorageInfo, StorageSegment } from "../shared/types";
import { formatBytes, parseAdbDevices, parseDfKilobytes, parseGetprop, parseKeyValues } from "./parse";
import { listApps } from "./manage";
import { photoLibrary } from "./photoLibrary";
import { run, ToolError } from "./tools";

const APPLE_DRIVER_HINT =
  "On Windows, install Apple's \"Apple Devices\" app (or iTunes) from Microsoft Store so iPhones can connect over USB.";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function listIos(errors: string[]): Promise<Device[]> {
  let udids: string[];
  try {
    udids = (await run("idevice_id", ["-l"])).split(/\r?\n/).filter(Boolean);
  } catch (e) {
    errors.push(`iPhone: ${message(e)}${process.platform === "win32" ? ` ${APPLE_DRIVER_HINT}` : ""}`);
    return [];
  }
  return Promise.all(
    udids.map(async (id): Promise<Device> => {
      try {
        await run("idevicepair", ["-u", id, "validate"]);
      } catch {
        return { id, platform: "ios", name: "iPhone (not trusted)", state: "untrusted" };
      }
      try {
        const name = (await run("ideviceinfo", ["-u", id, "-k", "DeviceName"])).trim();
        return { id, platform: "ios", name: name || "iPhone", state: "ready" };
      } catch {
        return { id, platform: "ios", name: "iPhone", state: "offline" };
      }
    }),
  );
}

// The name the person gave the phone (Settings › About phone), asked once per phone: devices are polled often.
const androidNames = new Map<string, string>();
async function androidName(serial: string): Promise<string | undefined> {
  if (!androidNames.has(serial)) {
    const name = (await run("adb", ["-s", serial, "shell", "settings", "get", "global", "device_name"]).catch(() => "")).trim();
    if (name && name !== "null") androidNames.set(serial, name);
  }
  return androidNames.get(serial);
}

async function listAndroid(errors: string[]): Promise<Device[]> {
  try {
    return await Promise.all(
      parseAdbDevices(await run("adb", ["devices", "-l"])).map(async (d) => ({
        id: d.serial,
        platform: "android" as const,
        name: (d.state === "device" ? await androidName(d.serial) : undefined) ?? d.model ?? (d.state === "unauthorized" ? "Android (allow USB debugging)" : "Android"),
        state: d.state === "device" ? ("ready" as const) : d.state === "unauthorized" ? ("untrusted" as const) : ("offline" as const),
      })),
    );
  } catch (e) {
    errors.push(`Android: ${message(e)}`);
    return [];
  }
}

export async function listDevices(): Promise<DeviceListResult> {
  const errors: string[] = [];
  const [ios, android] = await Promise.all([listIos(errors), listAndroid(errors)]);
  return { devices: [...ios, ...android], errors };
}

/** Keeps ids from being read as tool options; ids come from the renderer. */
export function assertDeviceId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.:_-]{0,127}$/.test(id)) throw new Error("Invalid device id");
}

function pick(fields: [string, string | undefined][]): [string, string][] {
  return fields.filter((f): f is [string, string] => Boolean(f[1]));
}

export async function deviceInfo(platform: Platform, id: string): Promise<DeviceInfo> {
  if (platform === "ios") {
    const kv = parseKeyValues(await run("ideviceinfo", ["-u", id]));
    let disk: Record<string, string> = {};
    try {
      disk = parseKeyValues(await run("ideviceinfo", ["-u", id, "-q", "com.apple.disk_usage"]));
    } catch {
      // Some iOS versions refuse this domain; capacity is then left out.
    }
    let battery: Record<string, string> = {};
    try {
      battery = parseKeyValues(await run("ideviceinfo", ["-u", id, "-q", "com.apple.mobile.battery"]));
    } catch {
      // Same as above.
    }
    return {
      id,
      platform,
      fields: pick([
        ["Name", kv.DeviceName],
        ["Model", kv.ProductType],
        ["iOS", kv.ProductVersion && `${kv.ProductVersion} (${kv.BuildVersion ?? "?"})`],
        ["Serial number", kv.SerialNumber],
        ["Phone number", kv.PhoneNumber],
        ["IMEI", kv.InternationalMobileEquipmentIdentity],
        ["Wi-Fi address", kv.WiFiAddress],
        ["Capacity", formatBytes(disk.TotalDiskCapacity)],
        ["Available", formatBytes(disk.AmountDataAvailable)],
        ["Battery", battery.BatteryCurrentCapacity && `${battery.BatteryCurrentCapacity}%`],
        ["UDID", id],
      ]),
    };
  }
  const p = parseGetprop(await run("adb", ["-s", id, "shell", "getprop"]));
  let battery: string | undefined;
  try {
    battery = (await run("adb", ["-s", id, "shell", "dumpsys", "battery"])).match(/level: (\d+)/)?.[1];
  } catch {
    // Battery stays unknown.
  }
  return {
    id,
    platform,
    fields: pick([
      ["Model", [p["ro.product.manufacturer"], p["ro.product.model"]].filter(Boolean).join(" ")],
      ["Android", p["ro.build.version.release"] && `${p["ro.build.version.release"]} (SDK ${p["ro.build.version.sdk"]})`],
      ["Build", p["ro.build.display.id"]],
      ["Battery", battery && `${battery}%`],
      ["Serial", id],
    ]),
  };
}

/**
 * Storage split for the Home view. iPhone: System partition, installed apps (program + data,
 * from ideviceinstaller), Other = remaining used space, Free. Android only reports used/free.
 */
export async function storage(platform: Platform, id: string): Promise<StorageInfo> {
  if (platform === "android") {
    const df = parseDfKilobytes(await run("adb", ["-s", id, "shell", "df", "-k", "/data"]));
    if (!df) throw new Error("Could not read storage from the phone.");
    return { segments: [{ name: "Used", bytes: df.used }, { name: "Free", bytes: df.free }], totalBytes: df.total };
  }
  const disk = parseKeyValues(await run("ideviceinfo", ["-u", id, "-q", "com.apple.disk_usage"]));
  const num = (k: string) => Number(disk[k]) || 0;
  const free = num("AmountDataAvailable");
  const used = num("TotalDataCapacity") - free;
  // A failed query leaves its share in Other rather than failing the whole view.
  const [appList, library] = await Promise.all([listApps("ios", id).catch(() => []), photoLibrary("ios", id).catch(() => undefined)]);
  const apps = Math.min(used, appList.reduce((s, a) => s + (a.appBytes ?? 0) + (a.dataBytes ?? 0), 0));
  // Recently Deleted items still take space until iOS removes them, so they count here.
  const photos = Math.min(used - apps, library?.assets.reduce((s, a) => s + (a.bytes ?? 0), 0) ?? 0);
  const segments: StorageSegment[] = [
    { name: "System", bytes: num("TotalSystemCapacity") },
    { name: "Apps", bytes: apps },
    { name: "Photos", bytes: photos },
    { name: "Other", bytes: used - apps - photos },
    { name: "Free", bytes: free },
  ];
  return { segments, totalBytes: segments.reduce((s, x) => s + x.bytes, 0) };
}

/** iPhone: shows the Trust prompt. Android: USB-debugging prompt appears on its own; just report. */
export async function pair(platform: Platform, id: string): Promise<string> {
  if (platform === "android") return "Unlock the phone and tap Allow on the USB debugging prompt.";
  try {
    return (await run("idevicepair", ["-u", id, "pair"], { timeoutMs: 60_000 })).trim();
  } catch (e) {
    if (e instanceof ToolError && /passcode|trust|dialog/i.test(e.output))
      return "Unlock the iPhone and tap Trust, then try again.";
    throw e;
  }
}
