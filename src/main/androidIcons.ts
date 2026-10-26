// Android launcher icons, read from each app's package on the phone (no helper app installed).
// The phone unzips only the manifest, the resource table and the icon file itself, so the full
// package (often 100+ MB) never crosses the cable.
// ponytail: icons drawn only as vectors (no picture layer) aren't converted yet; those apps keep
// their letter badge. Add a VectorDrawable → SVG step if that matters.
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { storageRoot } from "./backups";
import { attr, cssColor, findElement, parseResTable, parseXml, type ResTable, TYPE_REFERENCE, TYPE_STRING } from "./apk";
import { run, spawnTool } from "./tools";

const ANDROID_ICON = 0x01010002;
const ANDROID_DRAWABLE = 0x01010199;
const ANYDPI = 0xfffe;
const BITMAP = /\.(png|webp|jpg)$/i;

/** Kept across sessions; the key includes the install path, which changes on every update. */
const cacheDir = () => join(storageRoot(), "AppIcons");

function bytes(id: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawnTool("adb", ["-s", id, "exec-out", ...args]);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`adb exited with ${code}`));
    });
  });
}

/** Follows references to the final value(s): every configuration of the resource. */
function resolve(table: ResTable, resId: number, depth = 0): { string?: string; color?: string; density: number }[] {
  if (depth > 5) return [];
  return table.entries(resId).flatMap((e) =>
    e.value.type === TYPE_REFERENCE ? resolve(table, e.value.data >>> 0, depth + 1) : [{ string: e.value.type === TYPE_STRING ? e.value.string : undefined, color: cssColor(e.value), density: e.density }],
  );
}

/** Densest picture file among the configurations, if any. */
const bestBitmap = (values: { string?: string; density: number }[]) =>
  values.filter((v) => v.string && BITMAP.test(v.string) && v.density !== ANYDPI).sort((a, b) => b.density - a.density)[0]?.string;

type Layer = { color: string } | { image: Buffer; type: string };

/** An adaptive icon as SVG: 108-unit layers, of which the middle 72 show (Android's safe zone). */
function adaptiveSvg(background: Layer, foreground: Layer): string {
  const layer = (l: Layer) =>
    "color" in l ? `<rect x="0" y="0" width="108" height="108" fill="${l.color}"/>` : `<image x="0" y="0" width="108" height="108" href="data:${l.type};base64,${l.image.toString("base64")}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 72 72">${layer(background)}${layer(foreground)}</svg>`;
}

/** Writes the app's icon to dir as <pkg>.png (a picture) or <pkg>.svg (adaptive layers); false if none. */
async function fetchIcon(id: string, pkg: string, apk: string, dir: string): Promise<boolean> {
  const manifest = parseXml(await bytes(id, ["unzip", "-p", apk, "AndroidManifest.xml"]));
  const application = findElement(manifest, "application");
  const icon = application && attr(application, ANDROID_ICON, "icon");
  if (!icon || icon.value.type !== TYPE_REFERENCE) return false;
  const table = parseResTable(await bytes(id, ["unzip", "-p", apk, "resources.arsc"]));
  const values = resolve(table, icon.value.data >>> 0);
  const file = (path: string) => bytes(id, ["unzip", "-p", apk, path]);

  const bitmap = bestBitmap(values);
  if (bitmap) {
    await writeFile(join(dir, `${pkg}.png`), await file(bitmap)); // webp too: the browser reads the bytes, not the name
    return true;
  }
  const xml = values.find((v) => v.string?.endsWith(".xml"))?.string;
  if (!xml) return false;
  const adaptive = parseXml(await file(xml));
  if (adaptive.name !== "adaptive-icon") return false;
  const layerOf = async (name: string): Promise<Layer | undefined> => {
    const el = findElement(adaptive, name);
    const ref = el && attr(el, ANDROID_DRAWABLE, "drawable");
    if (!ref) return undefined;
    const color = cssColor(ref.value);
    if (color) return { color };
    if (ref.value.type !== TYPE_REFERENCE) return undefined;
    const layer = resolve(table, ref.value.data >>> 0);
    const found = layer.find((v) => v.color)?.color;
    if (found) return { color: found };
    const path = bestBitmap(layer);
    return path ? { image: await file(path), type: path.endsWith(".png") ? "image/png" : path.endsWith(".jpg") ? "image/jpeg" : "image/webp" } : undefined;
  };
  const [background, foreground] = await Promise.all([layerOf("background"), layerOf("foreground")]);
  if (!background || !foreground) return false;
  await writeFile(join(dir, `${pkg}.svg`), adaptiveSvg(background, foreground));
  return true;
}

const CONCURRENCY = 4;

/** Icons for these apps (cached ones at once, others fetched); returns the ids that have one. */
export async function androidAppIcons(id: string, packages: string[]): Promise<string[]> {
  const dir = cacheDir();
  await mkdir(dir, { recursive: true });
  const cached = new Set(await readdir(dir));
  const paths = new Map(
    (await run("adb", ["-s", id, "shell", "pm", "list", "packages", "-f", "-3"], { timeoutMs: 60_000 }))
      .split(/\r?\n/)
      .map((l) => l.match(/^package:(.+\.apk)=(.+)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[2].trim(), m[1]] as const),
  );
  const found: string[] = [];
  const queue = packages.filter((p) => paths.has(p));
  const worker = async () => {
    for (let pkg = queue.shift(); pkg; pkg = queue.shift()) {
      const apk = paths.get(pkg)!;
      const key = `${pkg}@${createHash("sha1").update(apk).digest("hex").slice(0, 12)}`;
      if (cached.has(`${key}.png`) || cached.has(`${key}.svg`) || (await fetchIcon(id, key, apk, dir).catch(() => false))) found.push(pkg);
      iconKeys.set(pkg, key);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return packages.filter((p) => found.includes(p));
}

/** pkg → cache key of the installed version, filled by androidAppIcons. */
const iconKeys = new Map<string, string>();

/** The cached icon file for a package, if one was fetched. */
export async function androidIconFile(pkg: string): Promise<string | undefined> {
  const key = iconKeys.get(pkg);
  if (!key) return undefined;
  const names = await readdir(cacheDir()).catch(() => [] as string[]);
  const name = names.find((n) => n === `${key}.png` || n === `${key}.svg`);
  return name && join(cacheDir(), name);
}
