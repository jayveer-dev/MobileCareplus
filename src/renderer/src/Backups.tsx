import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import type { Backup, BackupContents, Device, Task } from "../../shared/types";

const formatSize = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
const formatDate = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "Unknown date");

export interface PasswordRequest {
  title: string;
  detail: string;
  /** Setting a new password: ask twice, since a typo would leave backups unreadable. */
  confirm?: boolean;
  /** Label for the OK button, e.g. "Turn on encryption". */
  action?: string;
  /** Field label when it isn't a password, e.g. "64-digit key". */
  label?: string;
  submit: (password: string) => Promise<void>;
}

/** The Backup & Restore screen: full backup, then children (Save as files), then the backups list. */
export function BackupPanel({ device, tasks, children }: { device: Device; tasks: Task[]; children?: ReactNode }) {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [encrypted, setEncrypted] = useState<boolean>();
  const [error, setError] = useState<string>();
  const [prompt, setPrompt] = useState<PasswordRequest>();
  const [openContents, setOpenContents] = useState<string>();

  const busy = tasks.some((t) => t.deviceId === device.id && t.state === "running");
  const refresh = useCallback(async () => {
    setBackups(await window.backups.list());
    setEncrypted(await window.backups.encryption(device.id).catch(() => undefined));
  }, [device.id]);

  // Reload the list whenever one of this device's tasks finishes.
  const finishedCount = tasks.filter((t) => t.deviceId === device.id && t.state !== "running").length;
  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [refresh, finishedCount]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };

  const toggleEncryption = () =>
    setPrompt({
      title: encrypted ? "Turn off backup encryption" : "Encrypt backups",
      detail: encrypted
        ? "Enter the current backup password."
        : "Choose a password. Without it, encrypted backups can't be restored or read, and it can't be recovered, so save it in a password manager. Mobile Care Plus doesn't keep it. Keep the iPhone unlocked; it may ask for its passcode.",
      confirm: !encrypted,
      action: encrypted ? "Turn off encryption" : "Turn on encryption",
      submit: async (pw) => {
        await window.backups.setEncryption(device.id, !encrypted, pw);
        await refresh();
      },
    });

  const restore = (b: Backup) => {
    const run = (password?: string) => window.backups.restore(device.id, { sourceId: b.sourceId, password }).then(() => {});
    if (!b.encrypted) return act(run);
    setPrompt({ title: "Backup password", detail: `"${b.deviceName}" backup is encrypted.`, submit: run });
  };

  const last = backups.find((b) => b.sourceId === device.id);

  return (
    <div className="backups">
      <section className="bk-card" id="backup-whole" aria-labelledby="bk-whole-title">
        <div className="bk-head">
          <div>
            <h2 id="bk-whole-title">Full backup</h2>
            <p className="muted">Everything on the iPhone in one backup you can restore to this or a new iPhone.</p>
          </div>
          <button disabled={busy} onClick={() => act(() => window.backups.start(device.id))}>
            Back up now
          </button>
        </div>
        <div className="bk-foot">
          <span className="muted small">{last ? `Last backup ${formatDate(last.date)} · ${formatSize(last.sizeBytes)}` : "Not backed up to this computer yet"}</span>
          <span className="spacer" />
          {encrypted !== undefined && (
            <label className="toggle" title="Encrypted backups also include saved passwords, Health and Wi-Fi settings.">
              <input type="checkbox" checked={encrypted} disabled={busy} onChange={toggleEncryption} />
              Encrypt backups <span className="muted small">(adds passwords, Health, Wi-Fi)</span>
            </label>
          )}
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      {children}

      <h2 className="bk-list-title">Backups on this computer</h2>
      {backups.length === 0 && <p className="muted">No backups yet.</p>}
      <ul className="list">
        {backups.map((b) => (
          <li key={b.sourceId} className="backup-item">
            <div className="backup-row">
            <div>
              <div className="name">
                {b.deviceName} {b.encrypted && <span className="pill">Encrypted</span>}
                {b.sourceId === device.id && <span className="pill">This iPhone</span>}
              </div>
              <div className="muted small">
                {formatDate(b.date)} · iOS {b.iosVersion ?? "?"} · {formatSize(b.sizeBytes)}
              </div>
            </div>
            <div className="row">
              <button disabled={busy} onClick={() => restore(b)}>
                Restore
              </button>
              <button
                className="secondary"
                aria-expanded={openContents === b.sourceId}
                onClick={() => setOpenContents((s) => (s === b.sourceId ? undefined : b.sourceId))}
              >
                What's inside
              </button>
              <button className="secondary" onClick={() => window.backups.reveal(b.sourceId)}>
                Show
              </button>
              <button
                className="secondary danger"
                disabled={busy}
                onClick={() => act(async () => (await window.backups.remove(b.sourceId)) && refresh())}
              >
                Delete
              </button>
            </div>
            </div>
            {openContents === b.sourceId && <ContentsView key={`${b.sourceId}:${b.date}`} sourceId={b.sourceId} />}
          </li>
        ))}
      </ul>
      {prompt && <PasswordDialog request={prompt} onClose={() => setPrompt(undefined)} />}
    </div>
  );
}

function ContentsView({ sourceId }: { sourceId: string }) {
  const [contents, setContents] = useState<BackupContents>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    window.backups.contents(sourceId).then(setContents, (e: Error) => setError(e.message));
  }, [sourceId]);

  if (error) return <p className="error small">{error}</p>;
  if (!contents) return <p className="muted small">Reading backup…</p>;
  if (contents.kind === "encrypted")
    return <p className="muted small">This backup is encrypted, so its contents can't be listed without the password.</p>;
  const max = Math.max(...contents.categories.map((c) => c.bytes), 1);
  return (
    <table className="contents">
      <tbody>
        {contents.categories.map((c) => (
          <tr key={c.name}>
            <th scope="row">{c.name}</th>
            <td className="bar-cell">
              <span className="bar" style={{ width: `${(c.bytes / max) * 100}%` }} />
            </td>
            <td className="num">{formatSize(c.bytes)}</td>
            <td className="num muted">
              {c.files.toLocaleString()} {c.files === 1 ? "file" : "files"}
              {c.name === "App data" && contents.apps > 0 && ` · ${contents.apps} apps`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PasswordDialog({ request, onClose }: { request: PasswordRequest; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const mismatch = request.confirm && again.length > 0 && again !== password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (request.confirm && again !== password) return setError("The passwords don't match.");
    setWorking(true);
    setError(undefined);
    try {
      await request.submit(password);
      onClose();
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      setWorking(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="pw-title">
      <form className="dialog" onSubmit={submit}>
        <h3 id="pw-title">{request.title}</h3>
        <p className="muted">{request.detail}</p>
        <label className="field">
          <span className="small muted">{request.label ?? (request.confirm ? "New password" : "Password")}</span>
          <input type="password" autoFocus autoComplete={request.label ? "off" : request.confirm ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {request.confirm && (
          <label className="field">
            <span className="small muted">Type it again</span>
            <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} aria-invalid={mismatch || undefined} aria-describedby={mismatch ? "pw-mismatch" : undefined} />
          </label>
        )}
        {mismatch && !error && (
          <p id="pw-mismatch" className="error small">
            The passwords don't match yet.
          </p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={!password || (request.confirm && again !== password) || working}>
            {working ? "Working…" : (request.action ?? "OK")}
          </button>
        </div>
      </form>
    </div>
  );
}

export function TaskBar({ tasks, devices }: { tasks: Task[]; devices: Device[] }) {
  const [hidden, setHidden] = useState<number[]>([]);
  const shown = tasks.filter((t) => t.state === "running" || !hidden.includes(t.id)).slice(0, 4);
  if (shown.length === 0) return null;
  const deviceName = (id: string) => devices.find((d) => d.id === id)?.name ?? "Disconnected device";
  return (
    <div className="taskbar">
      {shown.map((t) => (
        <div key={t.id} className={`task ${t.state}`}>
          <div className="task-head">
            <span>
              <strong>{t.title}</strong> · {deviceName(t.deviceId)}
            </span>
            <span className="muted small">
              {t.state === "running" ? (t.progress !== undefined ? `${Math.floor(t.progress)}%` : "Preparing on the phone…") : t.state}
            </span>
            {t.state === "running" ? (
              <button className="link" onClick={() => window.tasks.cancel(t.id)}>
                Cancel
              </button>
            ) : (
              <>
                {t.hasResult && (
                  <button className="link" onClick={() => window.tasks.reveal(t.id)}>
                    Show
                  </button>
                )}
              <button className="link" aria-label="Dismiss" onClick={() => setHidden((h) => [...h, t.id])}>
                ✕
              </button>
              </>
            )}
          </div>
          {t.state === "running" && (
            <progress max={100} value={t.progress ?? undefined} aria-label={`${t.title} progress`} />
          )}
          {t.state === "running" && t.detail && <div className="small muted">{t.detail}</div>}
          {t.message && <div className="small error">{t.message}</div>}
        </div>
      ))}
    </div>
  );
}
