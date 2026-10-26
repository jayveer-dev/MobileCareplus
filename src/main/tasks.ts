import type { Task } from "../shared/types";
import { failureReason, lastPercent } from "./parse";
import { spawnTool } from "./tools";

const KEEP_FINISHED = 20;
const OUTPUT_TAIL = 8 * 1024;

const tasks: Task[] = [];
/** How to stop each running task: kill its tool, or abort its job. */
const cancellers = new Map<number, () => void>();
/** Files a finished job produced, by task id; kept in the main process so the renderer never supplies a path. */
const results = new Map<number, string>();
export const taskResult = (id: number) => results.get(id);
let nextId = 1;
let notify: (tasks: Task[]) => void = () => {};

export function onTasksChanged(listener: (tasks: Task[]) => void) {
  notify = listener;
}

export const listTasks = () => tasks;

const changed = () => notify([...tasks]);

export function deviceBusy(deviceId: string) {
  return tasks.some((t) => t.deviceId === deviceId && t.state === "running");
}

interface StartTask {
  deviceId: string;
  title: string;
  tool: string;
  args: string[];
  env?: Record<string, string>;
  /** Some tools exit 0 after printing an error; return a reason to mark the task failed. */
  checkOutput?: (output: string) => string | undefined;
  /** Reads overall progress from an output chunk; defaults to the last `NN%`. */
  progress?: (chunk: string) => number | undefined;
  /** Turns failed output into a plain-language reason; falls back to the tool's last error line. */
  explain?: (output: string) => string | undefined;
  /** Describes the current step from an output chunk; undefined keeps the previous one. */
  describe?: (chunk: string) => string | undefined;
}

/** One running task per device: a second backup/restore on the same phone would corrupt both. */
function createTask(deviceId: string, title: string): Task {
  if (deviceBusy(deviceId)) throw new Error("This device is already busy with another task.");
  const task: Task = { id: nextId++, deviceId, title, state: "running" };
  tasks.unshift(task);
  const finished = tasks.filter((t) => t.state !== "running");
  for (const old of finished.slice(KEEP_FINISHED)) tasks.splice(tasks.indexOf(old), 1);
  return task;
}

export interface JobReport {
  progress?: number;
  detail?: string;
}

/** A task made of several tool calls run from code (e.g. copying photos one by one). */
export function startJob(deviceId: string, title: string, work: (report: (r: JobReport) => void, signal: AbortSignal) => Promise<string | void>): Task {
  const task = createTask(deviceId, title);
  const controller = new AbortController();
  cancellers.set(task.id, () => controller.abort());
  const report = (r: JobReport) => {
    if (task.state !== "running") return;
    task.progress = r.progress ?? task.progress;
    task.detail = r.detail ?? task.detail;
    changed();
  };
  work(report, controller.signal).then(
    (resultPath) => {
      if (task.state !== "running") return;
      Object.assign(task, { state: "done", progress: 100, detail: undefined });
      if (resultPath) {
        results.set(task.id, resultPath);
        task.hasResult = true;
      }
    },
    (err: Error) => {
      if (task.state === "running") Object.assign(task, { state: "failed", message: err.message, detail: undefined });
    },
  ).finally(() => {
    cancellers.delete(task.id);
    changed();
  });
  changed();
  return task;
}

export function startTask({ deviceId, title, tool, args, env, checkOutput, progress = lastPercent, describe, explain }: StartTask): Task {
  const task = createTask(deviceId, title);
  const child = spawnTool(tool, args, env);
  cancellers.set(task.id, () => child.kill());
  let tail = "";
  const onData = (buf: Buffer) => {
    const text = buf.toString();
    tail = (tail + text).slice(-OUTPUT_TAIL);
    const pct = progress(text);
    const detail = describe?.(text);
    if ((pct !== undefined && pct !== task.progress) || (detail !== undefined && detail !== task.detail)) {
      task.progress = pct ?? task.progress;
      task.detail = detail ?? task.detail;
      changed();
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (err) => {
    task.state = "failed";
    task.message = (err as NodeJS.ErrnoException).code === "ENOENT" ? `${tool} is not installed` : err.message;
    cancellers.delete(task.id);
    changed();
  });
  child.on("close", (code) => {
    cancellers.delete(task.id);
    if (task.state !== "running") return changed();
    const reason = code === 0 ? checkOutput?.(tail) : explain?.(tail) ?? failureReason(tail) ?? `${tool} exited with code ${code}`;
    task.state = reason ? "failed" : "done";
    task.message = reason;
    task.detail = undefined;
    if (!reason) task.progress = 100;
    changed();
  });
  changed();
  return task;
}

export function cancelTask(id: number) {
  const task = tasks.find((t) => t.id === id);
  const cancel = cancellers.get(id);
  if (!task || !cancel || task.state !== "running") return;
  task.state = "cancelled";
  cancel();
  changed();
}

/** Kill running tools when the app quits so no backup keeps writing in the background. */
export function cancelAll() {
  for (const id of cancellers.keys()) cancelTask(id);
}
