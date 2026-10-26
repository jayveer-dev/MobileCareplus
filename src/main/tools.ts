import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

// Finder/Explorer-launched apps get a minimal PATH, so also check the usual install dirs.
const EXTRA_DIRS: Record<string, string[]> = {
  darwin: ["/opt/homebrew/bin", "/usr/local/bin"],
  win32: [],
};

/** Bundled copy (resources/bin/<platform>) first, then known dirs, then plain PATH lookup. */
function resolveTool(name: string): string {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const bin = (root: string) => join(root, "resources", "bin", process.platform, exe);
  const bundled = [bin(app.isPackaged ? process.resourcesPath : app.getAppPath())];
  const candidates = [...bundled, ...(EXTRA_DIRS[process.platform] ?? []).map((d) => join(d, exe))];
  return candidates.find((p) => existsSync(p)) ?? exe;
}

/** What a missing helper means to the person: on Windows some helpers aren't built yet. */
const missing = (tool: string) => (process.platform === "win32" ? `This feature isn't available on Windows yet (needs ${tool}).` : `${tool} is not installed`);

export class ToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    readonly output: string,
  ) {
    super(message);
  }
}

export interface RunOptions {
  timeoutMs?: number;
  /** Extra variables, e.g. passwords that must not appear in argv. */
  env?: Record<string, string>;
  /** Written to the tool's stdin (e.g. plistutil -i -). */
  input?: string;
}

const childEnv = (env?: Record<string, string>) => (env ? { ...process.env, ...env } : undefined);

export function run(tool: string, args: string[], { timeoutMs = 15_000, env, input }: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      resolveTool(tool),
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: childEnv(env) },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const notFound = (err as NodeJS.ErrnoException).code === "ENOENT";
        const detail = (stderr || stdout || err.message).trim();
        reject(new ToolError(tool, notFound ? missing(tool) : detail, `${stdout}${stderr}`));
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** Long-running tool with streamed output (backups, restores). */
export function spawnTool(tool: string, args: string[], env?: Record<string, string>): ChildProcess {
  return spawn(resolveTool(tool), args, { env: childEnv(env), windowsHide: true });
}

/** Runs a long tool, streaming its output; rejects with the tail of its output on failure or abort. */
export function runStreaming(tool: string, args: string[], onChunk: (text: string) => void, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnTool(tool, args, env);
    let tail = "";
    const onData = (buf: Buffer) => {
      const text = buf.toString();
      tail = (tail + text).slice(-8192);
      onChunk(text);
    };
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => reject((err as NodeJS.ErrnoException).code === "ENOENT" ? new Error(missing(tool)) : err));
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(new Error("Cancelled"));
      else if (code === 0) resolve(tail);
      else reject(new ToolError(tool, tail.trim().split(/[\r\n]+/).at(-1) ?? `${tool} exited with code ${code}`, tail));
    });
  });
}
