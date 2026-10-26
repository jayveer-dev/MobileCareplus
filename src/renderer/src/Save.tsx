import { useEffect, useState } from "react";
import { type AndroidSaveCounts, type AndroidSavedFolder, type AndroidSaveType, BACKUP_LOCKED, type Device, type SaveType, type Task } from "../../shared/types";
import { PasswordDialog, type PasswordRequest } from "./Backups";

const AVAILABLE: [SaveType, string, string][] = [
  ["photos", "Photos & videos", "Original files"],
  ["contacts", "Contacts", "vCard and spreadsheet"],
  ["messages", "Messages & attachments", "A web page per conversation"],
  ["notes", "Notes", "Text files, by folder"],
  ["calendars", "Calendars", ".ics files for any calendar app"],
  ["bookmarks", "Safari bookmarks", "Importable into any browser"],
  ["calls", "Call history", "Spreadsheet · needs encryption on"],
  ["safariHistory", "Safari history", "Spreadsheet · needs encryption on"],
  ["health", "Health", "Measurements · needs encryption on"],
];

// Shown so nothing from the familiar list silently disappears; each says why it isn't ready.
const UNAVAILABLE: [string, string[]][] = [
  ["Coming next", ["Reminders", "Voicemail", "Voice memos"]],
  ["Chat apps, coming with Chat Transfer", ["WhatsApp", "Viber", "LINE", "Kik"]],
  ["Not in iPhone backups (re-downloaded from Apple)", ["Music", "Videos", "Podcasts", "Books"]],
];

export function SavePanel({ device, tasks }: { device: Device; tasks: Task[] }) {
  const [picked, setPicked] = useState<Set<SaveType>>(new Set(["photos", "contacts", "messages"]));
  const [folder, setFolder] = useState<string>();
  const [error, setError] = useState<string>();
  const [prompt, setPrompt] = useState<PasswordRequest>();
  const busy = tasks.some((t) => t.deviceId === device.id && t.state === "running");

  useEffect(() => {
    window.backups.saveFolder().then(setFolder);
  }, []);

  const toggle = (t: SaveType) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  const all = picked.size === AVAILABLE.length;

  const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const save = async () => {
    setError(undefined);
    try {
      await window.backups.saveSelected(device.id, [...picked]);
    } catch (e) {
      const message = clean(e);
      if (!message.startsWith(BACKUP_LOCKED)) return setError(message);
      setPrompt({
        title: "Backup password",
        detail: message.slice(BACKUP_LOCKED.length),
        // A wrong password rejects here, so the dialog stays open and shows why.
        submit: (password) => window.backups.saveSelected(device.id, [...picked], password).catch((err) => Promise.reject(new Error(clean(err)))),
      });
    }
  };

  return (
    <section className="bk-card save" id="backup-choose" aria-labelledby="bk-save-title">
      <div className="bk-head">
        <div>
          <h2 id="bk-save-title">Save as files</h2>
          <p className="muted">Pick what to keep as normal files you can open anywhere. Each save goes into its own dated folder.</p>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(AVAILABLE.map(([t]) => t)))} />
          Select all <span className="muted small">({picked.size} of {AVAILABLE.length})</span>
        </label>
      </div>

      <fieldset className="types">
        <legend className="visually-hidden">What to save</legend>
        {AVAILABLE.map(([t, label, as]) => (
          <label key={t} className={`type ${picked.has(t) ? "on" : ""}`}>
            <input type="checkbox" checked={picked.has(t)} onChange={() => toggle(t)} />
            <span>
              <span className="type-name">{label}</span>
              <span className="muted small">{as}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="save-bar">
        <div className="folder">
          <span className="muted small">Save to</span>
          <span className="path" title={folder}>
            {folder ?? "…"}
          </span>
        </div>
        <button
          className="secondary"
          onClick={async () => {
            const f = await window.backups.pickSaveFolder();
            if (f) setFolder(f);
          }}
        >
          Change…
        </button>
        <span className="spacer" />
        <button disabled={picked.size === 0 || busy} onClick={save}>
          {busy ? "Phone is busy…" : "Export to folder"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <details className="unavailable">
        <summary className="muted small">Not in this list yet</summary>
        {UNAVAILABLE.map(([why, items]) => (
          <p key={why}>
            <span className="muted small">{why}:</span> {items.join(", ")}
          </p>
        ))}
      </details>
      {prompt && <PasswordDialog request={prompt} onClose={() => setPrompt(undefined)} />}
    </section>
  );
}

const sizeOf = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

/**
 * Android "Back up to computer": photos, contacts and calendar as normal files. Android has no
 * whole-phone backup a computer can make (and apps can't be copied out), so the screen says so
 * instead of showing a button that can't work.
 */
export function AndroidSavePanel({ device, tasks }: { device: Device; tasks: Task[] }) {
  const [counts, setCounts] = useState<AndroidSaveCounts>();
  const [picked, setPicked] = useState<Set<AndroidSaveType>>(new Set(["photos", "contacts", "calendars"]));
  const [folder, setFolder] = useState<string>();
  const [saves, setSaves] = useState<AndroidSavedFolder[]>([]);
  const [error, setError] = useState<string>();
  const busy = tasks.some((t) => t.deviceId === device.id && t.state === "running");
  const finished = tasks.filter((t) => t.state !== "running").length;

  useEffect(() => {
    window.backups.saveFolder().then(setFolder);
    window.backups.androidCounts(device.id).then(setCounts, () => setCounts({}));
  }, [device.id]);
  useEffect(() => {
    window.backups.androidSaves().then(setSaves, () => {});
  }, [finished, folder]);

  const rows: [AndroidSaveType, string, string | undefined][] = [
    ["photos", "Photos & videos", counts?.photos && `${counts.photos.count.toLocaleString()} items, ${sizeOf(counts.photos.bytes)} · original files`],
    ["contacts", "Contacts", counts?.contacts !== undefined ? `${counts.contacts.toLocaleString()} contacts · vCard and spreadsheet` : "vCard and spreadsheet"],
    ["calendars", "Calendars", counts?.events !== undefined ? `${counts.events.toLocaleString()} events · .ics files for any calendar app` : ".ics files for any calendar app"],
  ];
  const toggle = (t: AndroidSaveType) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  const save = () => {
    setError(undefined);
    window.backups.saveAndroid(device.id, device.name, [...picked]).catch((e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
  };

  return (
    <div className="backups">
      <section className="bk-card save" aria-labelledby="bk-android-title">
        <div className="bk-head">
          <div>
            <h2 id="bk-android-title">Back up to computer</h2>
            <p className="muted">Save what's on {device.name} as normal files you can open anywhere. Each save goes into its own dated folder.</p>
          </div>
        </div>
        <fieldset className="types">
          <legend className="visually-hidden">What to save</legend>
          {rows.map(([t, label, as]) => (
            <label key={t} className={`type ${picked.has(t) ? "on" : ""}`}>
              <input type="checkbox" checked={picked.has(t)} onChange={() => toggle(t)} />
              <span>
                <span className="type-name">{label}</span>
                <span className="muted small">{as ?? "…"}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="save-bar">
          <div className="folder">
            <span className="muted small">Save to</span>
            <span className="path" title={folder}>
              {folder ?? "…"}
            </span>
          </div>
          <button
            className="secondary"
            onClick={async () => {
              const f = await window.backups.pickSaveFolder();
              if (f) setFolder(f);
            }}
          >
            Change…
          </button>
          <span className="spacer" />
          <button disabled={picked.size === 0 || busy} onClick={save}>
            {busy ? "Working…" : "Export to folder"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        <details className="unavailable">
          <summary className="muted small">Why no whole-phone backup?</summary>
          <p>
            <span className="muted small">
              Android phones no longer allow full backups to a computer, and apps can't be copied out. Apps, logins and settings move with your Google account when you set up a
              new phone; WhatsApp and other chats have their own backup in the Transfer window.
            </span>
          </p>
        </details>
      </section>

      <h2 className="bk-list-title">Saved on this computer</h2>
      {saves.length === 0 ? (
        <p className="muted">Nothing saved yet. Export to folder puts a dated folder here.</p>
      ) : (
        <ul className="list">
          {saves.map((s) => {
            const parts = [s.photos > 0 && `${s.photos.toLocaleString()} photos & videos`, s.contacts && "contacts", s.calendars > 0 && `${s.calendars} ${s.calendars === 1 ? "calendar" : "calendars"}`].filter(Boolean);
            return (
              <li key={s.dir} className="backup-item">
                <div className="backup-row">
                  <div>
                    <div className="name">{s.name}</div>
                    <div className="muted small">{parts.join(" · ")}</div>
                  </div>
                  <div className="row">
                    <button disabled={busy} onClick={() => window.backups.restoreAndroidSave(s.dir, device.id, device.name).catch((e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")))}>
                      Restore
                    </button>
                    <button className="secondary" onClick={() => window.backups.revealAndroidSave(s.dir)}>
                      Show
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
