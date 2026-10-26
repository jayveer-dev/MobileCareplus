// Toolbox tools that act on the connected phone. Each works per phone type and says so when it can't.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { app, shell } from "electron";
import type { Platform } from "../shared/types";
import { fileSafe } from "./formats";
import { saveStamp } from "./selective";
import { run, ToolError } from "./tools";

// Foldables have two displays and screencap prints a warning into a piped stream, so the capture
// goes to a file on the phone first, then comes over cleanly.
const PHONE_TMP = "/sdcard/.mobilecareplus-screenshot.png";

/** Captures the phone's screen into the Pictures folder and shows it in the file manager. */
export async function screenshot(platform: Platform, id: string, deviceName: string): Promise<string> {
  const dir = join(app.getPath("pictures"), "Mobile Care Plus");
  await mkdir(dir, { recursive: true });
  const file = join(dir, fileSafe(`${deviceName} ${saveStamp(new Date())}.png`, "screenshot.png"));
  if (platform === "android") {
    await run("adb", ["-s", id, "shell", "screencap", "-p", PHONE_TMP], { timeoutMs: 30_000 });
    await run("adb", ["-s", id, "pull", PHONE_TMP, file], { timeoutMs: 60_000 });
    await run("adb", ["-s", id, "shell", "rm", PHONE_TMP], { timeoutMs: 15_000 }).catch(() => {});
  } else {
    await run("idevicescreenshot", ["-u", id, file], { timeoutMs: 30_000 }).catch(async (e: unknown) => {
      await rm(file, { force: true });
      if (e instanceof ToolError && /screenshotr|[Dd]eveloper/.test(e.output))
        throw new Error("The iPhone only allows screenshots in Developer Mode (Settings › Privacy & Security › Developer Mode, then restart the iPhone) — and recent iOS versions may refuse even then. Take it on the iPhone (side + volume up) and copy it from Manage › Photos instead.");
      throw e;
    });
  }
  shell.showItemInFolder(file);
  return file;
}
