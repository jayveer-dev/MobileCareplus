import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, Conversation, Device, DeviceListResult, Task, TaskApi } from "../../../shared/types";
import { PasswordDialog, TaskBar } from "../Backups";
import { Icon, type IconName } from "../Icons";
import { PhoneSwitch } from "./PhoneSwitch";
import { TransferScreen } from "./Transfer";

type WaApp = "whatsapp" | "business";
type AndroidApp = WaApp | "gbwhatsapp";
interface AndroidStatus {
  installed: boolean;
  backup?: { name: string; date: string; bytes: number; encryption: string };
}
type Source = { kind: "loaded"; deviceId: string } | { kind: "saved"; dir: string } | { kind: "android"; token: string };
/** Where an Android backup is opened from with the key. */
type AndroidSource = { kind: "phone"; deviceId: string } | { kind: "saved"; dir: string };
interface DataStatus {
  date?: string;
  encrypted: boolean;
  unlocked: boolean;
  apps?: Record<WaApp, boolean>;
}
interface SavedBackup {
  dir: string;
  date: string;
  deviceName: string;
  platform: "ios" | "android";
  chats?: number;
  bytes: number;
}

declare global {
  interface Window {
    transfer: {
      devices(): Promise<DeviceListResult>;
      data: { status(deviceId: string): Promise<DataStatus | null>; load(deviceId: string): Promise<void>; unlock(deviceId: string, password: string): Promise<void> };
      wa: {
        saved(app: AndroidApp): Promise<SavedBackup[]>;
        chats(app: AndroidApp, source: Source): Promise<Conversation[]>;
        messages(app: AndroidApp, source: Source, chatId: number): Promise<ChatMessage[]>;
        backup(app: WaApp, deviceId: string, deviceName: string): Promise<void>;
        export(app: AndroidApp, source: Source, deviceId: string): Promise<boolean>;
        /** Decrypts with the 64-digit key; returns the token to read it by. */
        androidOpen(app: AndroidApp, source: AndroidSource, key: string): Promise<string>;
        android(app: AndroidApp, deviceId: string): Promise<AndroidStatus>;
        androidBackup(app: AndroidApp, deviceId: string, deviceName: string): Promise<void>;
      };
    };
    tasks: TaskApi;
  }
}

type AppId = WaApp | "gbwhatsapp" | "kik" | "viber";

interface ChatApp {
  id: AppId;
  name: string;
  /** Badge text and color: our own marks, not the apps' logos. */
  mark: string;
  color: string;
  platforms: string;
  /** Phones we support it on. */
  on: Device["platform"][];
}

const APPS: ChatApp[] = [
  { id: "whatsapp", name: "WhatsApp", mark: "W", color: "#1f9e57", platforms: "iPhone and Android", on: ["ios", "android"] },
  { id: "business", name: "WhatsApp Business", mark: "B", color: "#127f73", platforms: "iPhone and Android", on: ["ios", "android"] },
  { id: "gbwhatsapp", name: "GBWhatsApp", mark: "GB", color: "#0e8f86", platforms: "Android", on: ["android"] },
  { id: "kik", name: "Kik", mark: "kik", color: "#2b3141", platforms: "iPhone", on: ["ios"] },
  { id: "viber", name: "Viber", mark: "V", color: "#6a55e0", platforms: "iPhone", on: ["ios"] },
];

const isWa = (id: AppId): id is WaApp => id === "whatsapp" || id === "business";
const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const ago = (iso?: string) => {
  if (!iso) return "earlier";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} hours ago`;
  return new Date(iso).toLocaleString();
};
const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const POLL_MS = 2000;

export function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [open, setOpen] = useState<ChatApp>();
  const [switching, setSwitching] = useState(false);

  useEffect(() => window.tasks.onTasks(setTasks), []);
  useEffect(() => {
    let alive = true;
    const tick = () => window.transfer.devices().then((r) => alive && setDevices(r.devices), () => {});
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="tx">
      <header className="tx-top">
        <span className="tx-brand">
          <span className="brand-mark" aria-hidden="true" /> Mobile Care Plus Transfer
        </span>
        <span className="spacer" />
        <Phones devices={devices} />
      </header>
      <main className="tx-main">
        {switching ? (
          <PhoneSwitch devices={devices} onClose={() => setSwitching(false)} />
        ) : open ? (
          <AppScreen app={open} devices={devices} tasks={tasks} onBack={() => setOpen(undefined)} />
        ) : (
          <Picker onPick={setOpen} onSwitch={() => setSwitching(true)} />
        )}
      </main>
      <TaskBar tasks={tasks.filter((t) => t.state === "running" || t.hasResult || t.state === "failed")} devices={devices} />
    </div>
  );
}

function Phones({ devices }: { devices: Device[] }) {
  if (devices.length === 0) return <span className="muted small">No phone connected</span>;
  return (
    <ul className="tx-phones" aria-label="Connected phones">
      {devices.map((d) => (
        <li key={`${d.platform}:${d.id}`}>
          <span className={`dot ${d.state}`} aria-hidden="true" />
          {d.name}
          <span className="muted small">{d.platform === "ios" ? "iPhone" : "Android"}</span>
        </li>
      ))}
    </ul>
  );
}

function Badge({ app, size: px = 64 }: { app: ChatApp; size?: number }) {
  return (
    <span className="tx-badge" style={{ background: app.color, width: px, height: px, fontSize: px * (app.mark.length > 1 ? 0.3 : 0.42) }} aria-hidden="true">
      {app.mark}
    </span>
  );
}

function Picker({ onPick, onSwitch }: { onPick: (app: ChatApp) => void; onSwitch: () => void }) {
  return (
    <section>
      <article className="sw-card">
        <span className="sw-icon" aria-hidden="true">
          <Icon name="swap" size={26} />
        </span>
        <div className="sw-text">
          <h1 className="tx-title">Move to a new phone</h1>
          <p className="muted">Connect both phones and choose what to move: photos, videos and more. iPhone and Android.</p>
        </div>
        <button onClick={onSwitch}>Get started</button>
      </article>
      <h2 className="tx-title sw-apps-title">Chat apps</h2>
      <p className="tx-lede muted">Chats move app by app. Back them up, read them, export them, or move them between phones.</p>
      <ul className="tx-apps">
        {APPS.map((a) => (
          <li key={a.id}>
            <button className="tx-app" onClick={() => onPick(a)}>
              <Badge app={a} />
              <span className="tx-app-name">{a.name}</span>
              <span className="muted small">{a.platforms}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const phoneKey = (d: Device) => `${d.platform}:${d.id}`;
const kindName = (d: Device) => (d.platform === "ios" ? "iPhone" : "Android");

function AppScreen({ app, devices, tasks, onBack }: { app: ChatApp; devices: Device[]; tasks: Task[]; onBack: () => void }) {
  const [transferring, setTransferring] = useState(false);
  const [chosen, setChosen] = useState<string>();
  // Phones this app works on, ready to use; keep the person's choice while it stays connected.
  const phones = devices.filter((d) => d.state === "ready" && app.on.includes(d.platform));
  const phone = phones.find((d) => phoneKey(d) === chosen) ?? phones[0];
  if (transferring) return <TransferScreen name={app.name} devices={devices} onClose={() => setTransferring(false)} />;
  return (
    <section>
      <button className="quiet tx-back" onClick={onBack}>
        <span className="tx-back-icon">
          <Icon name="chevron" size={16} />
        </span>
        All apps
      </button>
      <div className="tx-app-head">
        <Badge app={app} size={56} />
        <div>
          <h1 className="tx-title">{app.name}</h1>
          <p className="muted">{app.platforms}</p>
        </div>
      </div>
      {phones.length > 1 && (
        <div className="segmented tx-phone-pick" role="group" aria-label="Phone">
          {phones.map((d) => (
            <button key={phoneKey(d)} aria-pressed={d === phone} onClick={() => setChosen(phoneKey(d))}>
              {d.name} <span className="muted small">{kindName(d)}</span>
            </button>
          ))}
        </div>
      )}
      {app.id === "kik" || app.id === "viber" ? (
        <p className="callout">{app.name} support follows WhatsApp: back up, view and export from iPhone are next.</p>
      ) : phone?.platform === "android" ? (
        <AndroidActions key={phone.id} app={app.id} name={app.name} phone={phone} tasks={tasks} onTransfer={() => setTransferring(true)} />
      ) : isWa(app.id) ? (
        <WhatsAppActions app={app.id} name={app.name} iphone={phone} tasks={tasks} onTransfer={() => setTransferring(true)} />
      ) : (
        <NoPhone name={app.name} app={app} />
      )}
    </section>
  );
}

function WhatsAppActions({ app, name, iphone, tasks, onTransfer }: { app: WaApp; name: string; iphone?: Device; tasks: Task[]; onTransfer: () => void }) {
  const [status, setStatus] = useState<DataStatus | null>();
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [viewing, setViewing] = useState<Source>();
  const busy = !!iphone && tasks.some((t) => t.deviceId === iphone.id && t.state === "running");
  const finished = tasks.filter((t) => t.state !== "running").length;

  const refresh = useCallback(async () => {
    setStatus(iphone ? await window.transfer.data.status(iphone.id) : null);
  }, [app, iphone]);
  useEffect(() => {
    refresh().catch((e) => setError(clean(e)));
  }, [refresh, finished]);

  const run = (action: () => Promise<unknown>) => {
    setError(undefined);
    action().catch((e) => setError(clean(e)));
  };
  const readable = !!status && status.unlocked;
  const present = readable && status.apps?.[app];

  if (viewing) return <Viewer app={app} source={viewing} onClose={() => setViewing(undefined)} />;

  return (
    <>
      <div className="tx-data">
        <span className="quick-icon">
          <Icon name="save" />
        </span>
        <div className="tx-data-text">
          {!iphone ? (
            <p>Connect the phone that has {name}: an unlocked iPhone, or an Android phone with USB debugging on.</p>
          ) : !status ? (
            <p>
              Load {name} from {iphone.name} to back it up, read it or export it. The first load takes a few minutes while the iPhone sends a backup; only your personal data is
              kept, not the whole phone.
            </p>
          ) : (
            <p>
              Loaded from {iphone.name} {ago(status.date)}.{" "}
              {!readable ? "The iPhone's backups are encrypted: unlock to read them." : present ? "" : `${name} isn't on this iPhone, or it has no chats yet.`}
            </p>
          )}
          {error && <p className="error small">{error}</p>}
        </div>
        {iphone && (
          <div className="row">
            {status && !readable && <button onClick={() => setAsking(true)}>Unlock</button>}
            <button className={status ? "secondary" : ""} disabled={busy} onClick={() => run(() => window.transfer.data.load(iphone.id))}>
              {busy ? "Loading…" : status ? "Load latest" : "Load from iPhone"}
            </button>
          </div>
        )}
      </div>

      <ul className="tx-actions">
        <ActionRow icon="restart" title="Transfer between phones" does={`Move ${name} chats from one phone to another, iPhone or Android, replacing or merging.`}>
          <button onClick={onTransfer}>Transfer</button>
        </ActionRow>
        <ActionRow icon="backup" title="Back up" does={`Save a copy of ${name} chats and media on this computer that stays after later loads.`}>
          <button disabled={!present || busy || !iphone} onClick={() => iphone && run(() => window.transfer.wa.backup(app, iphone.id, iphone.name))}>
            Back up now
          </button>
        </ActionRow>
        <ActionRow icon="message" title="View" does="Read chats and messages from the latest load or a saved backup.">
          <button className="secondary" disabled={!present || !iphone} onClick={() => iphone && setViewing({ kind: "loaded", deviceId: iphone.id })}>
            Latest load
          </button>
        </ActionRow>
        <ActionRow icon="save" title="Restore to phone" does={`Put a saved backup back into ${name} on an iPhone.`} soon="Next step" />
        <ActionRow icon="folder" title="Export to computer" does="Save every chat as a web page, with photos, videos and voice notes in folders.">
          <button className="secondary" disabled={!present || busy || !iphone} onClick={() => iphone && run(() => window.transfer.wa.export(app, { kind: "loaded", deviceId: iphone.id }, iphone.id))}>
            Export latest load
          </button>
        </ActionRow>
      </ul>

      <SavedList app={app} name={name} onView={(dir) => setViewing({ kind: "saved", dir })} onExport={iphone && !busy ? (dir) => run(() => window.transfer.wa.export(app, { kind: "saved", dir }, iphone.id)) : undefined} />

      {asking && iphone && (
        <PasswordDialog
          request={{
            title: "Backup password",
            detail: "The password chosen when backup encryption was turned on. It isn't the iPhone passcode. Unlocking takes a few seconds.",
            submit: async (password) => {
              await window.transfer.data.unlock(iphone.id, password).catch((e) => Promise.reject(new Error(clean(e))));
              await refresh();
            },
          }}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  );
}

/** Saved backups on this computer. iPhone ones can be read here; Android ones stay encrypted with the person's key. */
function SavedList({ app, name, onView, onExport, onAndroid }: {
  app: AndroidApp;
  name: string;
  onView?: (dir: string) => void;
  onExport?: (dir: string) => void;
  /** View or export an Android backup (asks for the key first). */
  onAndroid?: (dir: string, then: "view" | "export") => void;
}) {
  const [saved, setSaved] = useState<SavedBackup[]>([]);
  const finished = useTaskCount();
  useEffect(() => {
    window.transfer.wa.saved(app).then(setSaved, () => {});
  }, [app, finished]);
  return (
    <>
      <h2 className="dash-title tx-saved-title">Saved {name} backups</h2>
      {saved.length === 0 ? (
        <p className="muted">None yet. Back up now saves one here.</p>
      ) : (
        <ul className="list">
          {saved.map((b) => (
            <li key={b.dir} className="tx-saved">
              <div>
                <div className="app-name">
                  {new Date(b.date).toLocaleString()} <span className="pill">{b.platform === "ios" ? "iPhone" : "Android"}</span>
                </div>
                <div className="muted small">
                  {b.deviceName}, {b.chats !== undefined ? `${b.chats} chats, ` : "encrypted with your 64-digit key, "}
                  {size(b.bytes)}
                </div>
              </div>
              {b.platform === "android" && onAndroid && (
                <div className="row">
                  <button className="secondary" onClick={() => onAndroid(b.dir, "view")}>
                    View
                  </button>
                  <button className="secondary" onClick={() => onAndroid(b.dir, "export")}>
                    Export
                  </button>
                </div>
              )}
              {b.platform === "ios" && isWa(app) && (
                <div className="row">
                  <button className="secondary" onClick={() => onView?.(b.dir)}>
                    View
                  </button>
                  <button className="secondary" disabled={!onExport} onClick={() => onExport?.(b.dir)}>
                    Export
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Finished-task count, so lists refresh when a backup completes. */
function useTaskCount() {
  const [count, setCount] = useState(0);
  useEffect(() => window.tasks.onTasks((list) => setCount(list.filter((t) => t.state !== "running").length)), []);
  return count;
}

function NoPhone({ name, app }: { name: string; app: ChatApp }) {
  return (
    <>
      <p className="callout">Connect the Android phone that has {name}, with USB debugging on.</p>
      <SavedList app={app.id as AndroidApp} name={name} />
    </>
  );
}

// Opened Android backups this session, so the key is asked for once per backup.
const openedAndroid = new Map<string, string>();
const androidKey = (app: AndroidApp, s: AndroidSource) => `${app}:${s.kind === "phone" ? s.deviceId : s.dir}`;

/** Android: WhatsApp's own encrypted chat backup on the phone, copied as it is. */
function AndroidActions({ app, name, phone, tasks, onTransfer }: { app: AndroidApp; name: string; phone: Device; tasks: Task[]; onTransfer: () => void }) {
  const [status, setStatus] = useState<AndroidStatus>();
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState<{ source: AndroidSource; then: "view" | "export" }>();
  const [viewing, setViewing] = useState<string>();
  const busy = tasks.some((t) => t.deviceId === phone.id && t.state === "running");
  const finished = tasks.filter((t) => t.state !== "running").length;

  const check = useCallback(() => {
    setError(undefined);
    window.transfer.wa.android(app, phone.id).then(setStatus, (e) => setError(clean(e)));
  }, [app, phone.id]);
  useEffect(check, [check, finished]);

  const backup = status?.backup;
  const readable = backup?.encryption === "crypt15";
  const run = (action: () => Promise<unknown>) => {
    setError(undefined);
    action().catch((e) => setError(clean(e)));
  };
  // The key opens a backup once per session; after that View and Export reuse the opened copy.
  const withKey = (source: AndroidSource, then: "view" | "export") => {
    const token = openedAndroid.get(androidKey(app, source));
    if (!token) return setAsking({ source, then });
    if (then === "view") setViewing(token);
    else run(() => window.transfer.wa.export(app, { kind: "android", token }, phone.id));
  };

  if (viewing) return <Viewer app={app} source={{ kind: "android", token: viewing }} onClose={() => setViewing(undefined)} />;

  return (
    <>
      <div className="tx-data">
        <span className="quick-icon">
          <Icon name="save" />
        </span>
        <div className="tx-data-text">
          {!status ? (
            <p>Checking {phone.name}…</p>
          ) : backup ? (
            <>
              <p>
                {name} chat backup on {phone.name} from {new Date(backup.date).toLocaleString()}, {size(backup.bytes)}.
              </p>
              <p className="muted small">
                {backup.encryption === "crypt15"
                  ? "It's end-to-end encrypted with your 64-digit key, which only you have."
                  : `It uses an older format (${backup.encryption}). To read it on a computer, turn on End-to-end encrypted backup in ${name} and choose the 64-digit key.`}
              </p>
            </>
          ) : !status.installed ? (
            <p>{name} isn't installed on {phone.name}.</p>
          ) : (
            <p>
              {name} has no chat backup on {phone.name} yet. In {name}: Settings › Chats › Chat backup, turn on End-to-end encrypted backup with a 64-digit key, tap Back up, then
              check again.
            </p>
          )}
          {error && <p className="error small">{error}</p>}
        </div>
        <button
          className="secondary"
          onClick={() => {
            // A new backup may have been made on the phone: open it fresh next time.
            openedAndroid.delete(androidKey(app, { kind: "phone", deviceId: phone.id }));
            check();
          }}
        >
          Check again
        </button>
      </div>

      <ul className="tx-actions">
        <ActionRow icon="restart" title="Transfer between phones" does={`Move ${name} chats from one phone to another, iPhone or Android, replacing or merging.`}>
          <button onClick={onTransfer}>Transfer</button>
        </ActionRow>
        <ActionRow icon="backup" title="Back up" does={`Copy ${name}'s chat backup, photos, videos and voice notes from ${phone.name} to this computer.`}>
          <button disabled={!backup || busy} onClick={() => run(() => window.transfer.wa.androidBackup(app, phone.id, phone.name))}>
            {busy ? "Copying…" : "Back up now"}
          </button>
        </ActionRow>
        <ActionRow icon="message" title="View" does={`Read the chats in the backup on ${phone.name}, with your 64-digit key.`}>
          <button className="secondary" disabled={!readable} onClick={() => withKey({ kind: "phone", deviceId: phone.id }, "view")}>
            View chats
          </button>
        </ActionRow>
        <ActionRow icon="save" title="Restore to phone" does={`Put a saved backup back into ${name} on an Android phone.`} soon="Next step" />
        <ActionRow icon="folder" title="Export to computer" does="Save every chat as a web page. From a saved backup, photos, videos and voice notes are included.">
          <button className="secondary" disabled={!readable || busy} onClick={() => withKey({ kind: "phone", deviceId: phone.id }, "export")}>
            Export chats
          </button>
        </ActionRow>
      </ul>

      <SavedList app={app} name={name} onAndroid={(dir, then) => withKey({ kind: "saved", dir }, then)} />

      {asking && (
        <PasswordDialog
          request={{
            title: "Your 64-digit key",
            detail: `The key ${name} showed when you turned on end-to-end encrypted backup. It's used for this once and isn't saved.`,
            label: "64-digit key",
            action: "Open backup",
            submit: async (key) => {
              const token = await window.transfer.wa.androidOpen(app, asking.source, key).catch((e) => Promise.reject(new Error(clean(e))));
              openedAndroid.set(androidKey(app, asking.source), token);
              if (asking.then === "view") setViewing(token);
              else run(() => window.transfer.wa.export(app, { kind: "android", token }, phone.id));
            },
          }}
          onClose={() => setAsking(undefined)}
        />
      )}
    </>
  );
}

function ActionRow({ icon, title, does, soon, children }: { icon: IconName; title: string; does: string; soon?: string; children?: React.ReactNode }) {
  return (
    <li aria-disabled={soon ? "true" : undefined}>
      <span className="quick-icon">
        <Icon name={icon} />
      </span>
      <span className="tx-action-text">
        <span className="quick-title">{title}</span>
        <span className="muted small">{does}</span>
      </span>
      {soon ? <span className="tree-soon">{soon}</span> : children}
    </li>
  );
}

function Viewer({ app, source, onClose }: { app: AndroidApp; source: Source; onClose: () => void }) {
  const [chats, setChats] = useState<Conversation[]>();
  const [open, setOpen] = useState<Conversation>();
  const [thread, setThread] = useState<ChatMessage[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    window.transfer.wa.chats(app, source).then(
      (c) => {
        setChats(c);
        setOpen(c[0]);
      },
      (e) => setError(clean(e)),
    );
  }, [app, source]);
  useEffect(() => {
    if (!open) return;
    setThread(undefined);
    window.transfer.wa.messages(app, source, open.id).then(setThread, (e) => setError(clean(e)));
  }, [app, source, open]);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [thread]);

  const q = query.trim().toLowerCase();
  const shown = (chats ?? []).filter((c) => !q || c.title.toLowerCase().includes(q));
  return (
    <section>
      <button className="quiet tx-back" onClick={onClose}>
        <span className="tx-back-icon">
          <Icon name="chevron" size={16} />
        </span>
        Back
      </button>
      <h2 className="dash-title">{source.kind === "loaded" ? "Latest load" : source.kind === "android" ? "Chat backup" : "Saved backup"}</h2>
      {error && <p className="error">{error}</p>}
      {!chats ? (
        !error && <p className="muted">Reading chats…</p>
      ) : (
        <div className="messages">
          <div className="chat-list">
            <input type="search" className="search" placeholder="Search chats" aria-label="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} />
            <ul>
              {shown.map((c) => (
                <li key={c.id}>
                  <button aria-current={open?.id === c.id ? "true" : undefined} onClick={() => setOpen(c)}>
                    <span className="chat-title">{c.title}</span>
                    <span className="muted small">
                      {c.messages.toLocaleString()} {c.messages === 1 ? "message" : "messages"}
                      {c.service === "Group" ? ", group" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <section className="thread" aria-label={open ? `Chat with ${open.title}` : "Chat"}>
            {open && (
              <div className="thread-head">
                <h2>{open.title}</h2>
              </div>
            )}
            {!thread ? (
              <p className="muted">Loading…</p>
            ) : (
              <ol className="bubbles" ref={list}>
                {thread.slice(-500).map((m) => (
                  <li key={m.id} className={m.fromMe ? "me" : "them"}>
                    <span className="meta">
                      {!m.fromMe && open?.service === "Group" && m.sender ? `${m.sender}, ` : ""}
                      {m.date && new Date(m.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                    </span>
                    {m.text && <span className="text">{m.text}</span>}
                    {m.attachments.map((a) => (
                      <span key={a} className="file">
                        Attachment: {a}
                      </span>
                    ))}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
