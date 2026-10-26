import { useEffect, useRef, useState } from "react";
import type { BackupApi, Device, DeviceApi, ManageApi, ModulesApi, Task, TaskApi } from "../../shared/types";
import { BackupPanel, TaskBar } from "./Backups";
import { Manage } from "./Manage";
import { Home } from "./Home";
import { Icon, type IconName } from "./Icons";
import { AndroidSavePanel, SavePanel } from "./Save";
import { Toolbox } from "./Toolbox";

declare global {
  interface Window {
    devices: DeviceApi;
    backups: BackupApi;
    manage: ManageApi;
    tasks: TaskApi;
    modules: ModulesApi;
  }
}

const POLL_MS = 2000;
const key = (d: Pick<Device, "platform" | "id">) => `${d.platform}:${d.id}`;

export type Tab = "home" | "manage" | "backup" | "toolbox";
/** Opens a tab, optionally at a sub-section (a Manage section or a backup mode). */
export type Go = (tab: Tab, sub?: string) => void;
const TABS: [Tab, string, IconName][] = [
  ["home", "Home", "home"],
  ["manage", "Manage", "manage"],
  ["backup", "Backup & Restore", "backup"],
  ["toolbox", "Toolbox", "toolbox"],
];

export function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tab, setTab] = useState<Tab>("home");
  const [sub, setSub] = useState<string>();
  const go: Go = (t, s) => {
    setTab(t);
    setSub(s);
  };

  useEffect(() => window.tasks.onTasks(setTasks), []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await window.devices.list();
      if (!alive) return;
      setDevices(r.devices);
      setErrors(r.errors);
      setSelected((s) => (s && r.devices.some((d) => key(d) === s) ? s : r.devices[0] && key(r.devices[0])));
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const current = devices.find((d) => key(d) === selected);

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Sections">
        <div className="brand" aria-hidden="true">
          <span className="brand-mark" />
        </div>
        {TABS.map(([id, label, icon]) => (
          <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => go(id)}>
            <Icon name={icon} size={22} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <header className="topbar">
        {/* Home already shows the phone's name; the switcher appears there only when there's a choice. */}
        {(tab !== "home" || devices.length > 1) && <DevicePicker devices={devices} current={current} onSelect={(d) => setSelected(key(d))} />}
        <span className="spacer" />
        <TaskCenter tasks={tasks} devices={devices} />
      </header>
      <main className={tab === "home" ? "is-home" : ""}>
        {errors.map((e) => (
          <p key={e} className="banner error">
            {e}
          </p>
        ))}
        {!current ? (
          <NoDevice />
        ) : tab === "home" ? (
          <Home key={key(current)} device={current} go={go} />
        ) : tab === "backup" ? (
          current.state === "ready" ? (
            current.platform === "ios" ? (
              <BackupArea key={`${key(current)}:${sub}`} device={current} tasks={tasks} initial={sub === "choose" ? "choose" : "whole"} />
            ) : (
              <AndroidSavePanel key={key(current)} device={current} tasks={tasks} />
            )
          ) : (
            <p className="empty-note">{current.platform === "ios" ? "Trust this computer on the iPhone to back it up." : "Unlock the phone and allow USB debugging to back it up."}</p>
          )
        ) : tab === "manage" ? (
          <Manage key={`${key(current)}:${sub}`} device={current} initial={sub} />
        ) : (
          <Toolbox device={current} />
        )}
      </main>
      {/* Running work, plus finished saves so their Show button is at hand. */}
      <TaskBar tasks={tasks.filter((t) => t.state === "running" || t.hasResult || t.state === "failed")} devices={devices} />
    </div>
  );
}

/** One screen: full backup, save as files, backups list. Home's shortcuts scroll to their card. */
function BackupArea({ device, tasks, initial }: { device: Device; tasks: Task[]; initial: "whole" | "choose" }) {
  useEffect(() => {
    if (initial === "choose") document.getElementById("backup-choose")?.scrollIntoView({ block: "start" });
  }, [initial]);
  return (
    <BackupPanel device={device} tasks={tasks}>
      <SavePanel device={device} tasks={tasks} />
    </BackupPanel>
  );
}

function DevicePicker({ devices, current, onSelect }: { devices: Device[]; current?: Device; onSelect: (d: Device) => void }) {
  if (devices.length <= 1)
    return (
      <div className="device-chip">
        <span className={`dot ${current?.state ?? "none"}`} aria-hidden="true" />
        {current?.name ?? "No device"}
      </div>
    );
  return (
    <label className="device-chip">
      <span className={`dot ${current?.state ?? "none"}`} aria-hidden="true" />
      <select
        aria-label="Device"
        value={current ? key(current) : ""}
        onChange={(e) => {
          const d = devices.find((x) => key(x) === e.target.value);
          if (d) onSelect(d);
        }}
      >
        {devices.map((d) => (
          <option key={key(d)} value={key(d)}>
            {d.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function TaskCenter({ tasks, devices }: { tasks: Task[]; devices: Device[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const running = tasks.filter((t) => t.state === "running").length;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const deviceName = (id: string) => devices.find((d) => d.id === id)?.name ?? "Disconnected device";
  return (
    <div className="task-center" ref={ref}>
      <button className="quiet tasks-button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="tasks" size={18} /> Tasks{running > 0 && <span className="count">{running}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Tasks">
          {tasks.length === 0 ? (
            <p className="muted">Backups and restores you run show up here.</p>
          ) : (
            <ul>
              {tasks.map((t) => (
                <li key={t.id}>
                  <span className={`state ${t.state}`}>{stateLabel(t)}</span>
                  <span className="task-name">
                    {t.title}
                    <span className="muted"> on {deviceName(t.deviceId)}</span>
                  </span>
                  {t.message && <span className="error small">{t.message}</span>}
                  {t.hasResult && (
                    <button className="link show" onClick={() => window.tasks.reveal(t.id)}>
                      Show files
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function stateLabel(t: Task) {
  if (t.state === "running") return t.progress !== undefined ? `${Math.floor(t.progress)}%` : "Running";
  return { done: "Done", failed: "Failed", cancelled: "Cancelled" }[t.state];
}

function NoDevice() {
  return (
    <div className="no-device">
      <div className="phone-outline" aria-hidden="true" />
      <h1>Connect a phone</h1>
      <p className="muted">Use a USB cable that carries data. An iPhone asks you to tap Trust; an Android phone needs USB debugging turned on.</p>
    </div>
  );
}
