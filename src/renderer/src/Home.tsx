import { useEffect, useState } from "react";
import { type Device, type DeviceInfo, type HomeSummary, type StorageInfo, thumbUrl } from "../../shared/types";
import type { Go } from "./App";
import { Icon, type IconName } from "./Icons";

const INFO_REFRESH_MS = 10_000;
// Storage and the summary need slower queries (app sizes, photo list), so they refresh less often and
// the last reading is kept across tab switches.
const SLOW_REFRESH_MS = 60_000;
const storageCache = new Map<string, StorageInfo>();
const summaryCache = new Map<string, HomeSummary>();

const gb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB` : `${Math.round(bytes / 1e6)} MB`);
const count = (n: number | undefined) => (n === undefined ? "–" : n.toLocaleString());
const ago = (iso?: string) => {
  if (!iso) return "unknown";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} hours ago`;
  return new Date(iso).toLocaleDateString();
};

export function Home({ device, go }: { device: Device; go: Go }) {
  const [info, setInfo] = useState<DeviceInfo>();
  const [store, setStore] = useState<StorageInfo | undefined>(() => storageCache.get(device.id));
  const [summary, setSummary] = useState<HomeSummary | undefined>(() => summaryCache.get(device.id));
  const [status, setStatus] = useState<string>();
  const [report, setReport] = useState(false);
  const ready = device.state === "ready";
  const ios = device.platform === "ios";

  useEffect(() => {
    if (!ready) return;
    const loadInfo = () => window.devices.info(device.platform, device.id).then(setInfo, (e: Error) => setStatus(e.message));
    const loadSlow = () => {
      window.devices.storage(device.platform, device.id).then((s) => {
        storageCache.set(device.id, s);
        setStore(s);
      }, () => {});
      window.devices.summary(device.platform, device.id).then((s) => {
        summaryCache.set(device.id, s);
        setSummary(s);
      }, () => {});
    };
    loadInfo();
    loadSlow();
    const timers = [setInterval(loadInfo, INFO_REFRESH_MS), setInterval(loadSlow, SLOW_REFRESH_MS)];
    return () => timers.forEach(clearInterval);
  }, [device.platform, device.id, ready]);

  const pair = async () => {
    setStatus("Waiting for the phone…");
    try {
      setStatus(await window.devices.pair(device.platform, device.id));
    } catch (e) {
      setStatus((e as Error).message);
    }
  };
  const powerAction = async (action: "restart" | "shutdown") => {
    try {
      if (await window.devices.power(device.platform, device.id, action)) setStatus(action === "restart" ? "Restarting… it will reconnect in about a minute." : "Shutting down…");
    } catch (e) {
      setStatus((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };

  const battery = summary?.battery;
  const backup = summary?.lastBackup;

  return (
    <div className="home">
      <aside className="device-col">
        <div className="device-title">
          <h1>{device.name}</h1>
          <p className="muted">{[summary?.modelName, summary?.osVersion].filter(Boolean).join(" · ") || (device.platform === "ios" ? "iPhone" : "Android")}</p>
        </div>
        <Phone android={!ios} battery={battery?.level} charging={battery?.charging} />
        {ready && (
          <div className="phone-controls" role="group" aria-label="Phone power">
            <button className="quiet" onClick={() => powerAction("shutdown")}>
              <Icon name="power" size={18} /> Shut down
            </button>
            <button className="quiet" onClick={() => powerAction("restart")}>
              <Icon name="restart" size={18} /> Restart
            </button>
          </div>
        )}
        {ready && (
          <button className="secondary wide" onClick={() => setReport(true)}>
            <Icon name="pulse" size={18} /> Health report
          </button>
        )}
      </aside>

      <section className="dash">
        {device.state === "untrusted" && (
          <div className="callout">
            <p>
              {ios
                ? "This iPhone hasn't trusted this computer yet. Unlock it, then tap Trust when it asks."
                : "This phone hasn't allowed USB debugging from this computer yet. Unlock it and tap Allow."}
            </p>
            {ios && <button onClick={pair}>Ask iPhone to trust</button>}
          </div>
        )}
        {device.state === "offline" && <p className="callout">The phone is connected but not answering. Unplug it and plug it back in.</p>}
        {status && <p className="status muted">{status}</p>}

        {ready && (
          <>
            <h2 className="dash-title">Manage</h2>
            <div className="cards">
              <article className="card">
                <header>
                  <span className="card-icon photos">
                    <Icon name="photo" />
                  </span>
                  <h3>Photos & videos</h3>
                  <span className="muted num">{summary?.photos && gb(summary.photos.bytes)}</span>
                </header>
                <p className="big num">{count(summary?.photos?.count)}</p>
                <p className="muted small">{ios ? "in the Photos library" : "photos and videos on the phone"}</p>
                <div className="thumbs">
                  {(summary?.photos?.recent ?? []).map((path) => (
                    <img key={path} src={thumbUrl(device.id, path)} alt="" />
                  ))}
                  {Array.from({ length: Math.max(0, 3 - (summary?.photos?.recent.length ?? 0)) }, (_, i) => (
                    <span key={i} className="thumb-empty" />
                  ))}
                </div>
                <button className="wide" onClick={() => go("manage", "photos")}>
                  <Icon name="save" size={18} /> Copy to computer
                </button>
              </article>
              <article className="card">
                <header>
                  <span className="card-icon apps">
                    <Icon name="apps" />
                  </span>
                  <h3>Apps</h3>
                  <span className="muted num">{summary?.apps?.bytes !== undefined && gb(summary.apps.bytes)}</span>
                </header>
                <p className="big num">{count(summary?.apps?.count)}</p>
                <p className="muted small">installed by you</p>
                {summary?.apps?.largest && summary.apps.largest.length > 0 && (
                  <ul className="largest">
                    {summary.apps.largest.map((a) => (
                      <li key={a.name}>
                        <span>{a.name}</span>
                        <span className="muted num">{gb(a.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="spacer-v" />
                <button className="secondary wide" onClick={() => go("manage", "apps")}>
                  Review and remove apps
                </button>
              </article>
            </div>

            <h2 className="dash-title">Quick access</h2>
            <ul className="quick">
              {ios && (
                <QuickItem
                  icon="backup"
                  title="Back up now"
                  detail={backup ? `Last backup ${ago(backup.date)}${backup.encrypted ? ", encrypted" : ""}` : "No backup on this computer yet"}
                  onClick={() => go("backup", "whole")}
                />
              )}
              {ios && <QuickItem icon="save" title="Choose what to save" detail="Photos, contacts, messages, notes… as normal files" onClick={() => go("backup", "choose")} />}
              {ios && (
                <QuickItem
                  icon="message"
                  title="Messages"
                  detail={summary?.conversations !== undefined ? `${count(summary.conversations)} conversations` : backup?.locked ? "Unlock the backup to read them" : "Read and export from a backup"}
                  onClick={() => go("manage", "messages")}
                />
              )}
              {ios && (
                <QuickItem
                  icon="contact"
                  title="Contacts"
                  detail={summary?.contacts !== undefined ? `${count(summary.contacts)} contacts` : backup?.locked ? "Unlock the backup to read them" : "Export as vCard or spreadsheet"}
                  onClick={() => go("manage", "contacts")}
                />
              )}
              {!ios && <QuickItem icon="photo" title="Photos & videos" detail="Browse, view and copy to this computer" onClick={() => go("manage", "photos")} />}
              {!ios && <QuickItem icon="apps" title="Apps" detail="See and uninstall apps" onClick={() => go("manage", "apps")} />}
            </ul>
          </>
        )}
      </section>

      {ready && <StorageBar store={store} />}
      {report && <HealthReport info={info} summary={summary} onClose={() => setReport(false)} />}
    </div>
  );
}

function QuickItem({ icon, title, detail, onClick }: { icon: IconName; title: string; detail: string; onClick: () => void }) {
  return (
    <li>
      <button className="quick-item" onClick={onClick}>
        <span className="quick-icon">
          <Icon name={icon} />
        </span>
        <span className="quick-text">
          <span className="quick-title">{title}</span>
          <span className="muted small">{detail}</span>
        </span>
        <Icon name="chevron" size={18} />
      </button>
    </li>
  );
}

/** Phone drawing with a live clock; the wallpaper is Mobile Care Plus's own. Android gets its own shape. */
function Phone({ android, battery, charging }: { android: boolean; battery?: number; charging?: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <figure className={`phone ${android ? "android" : ""}`} aria-label={`Phone${battery !== undefined ? `, battery ${battery}%${charging ? ", charging" : ""}` : ""}`}>
      <div className="phone-screen">
        <span className={android ? "phone-camera" : "phone-island"} />
        {battery !== undefined && (
          <span className="phone-battery num">
            {charging ? "⚡︎" : ""}
            {battery}%
          </span>
        )}
        <span className="phone-time num">{now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, "")}</span>
        <span className="phone-date">{now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>
      </div>
    </figure>
  );
}

const SEGMENT_LABEL: Record<string, string> = { System: "System", Apps: "Apps", Photos: "Photos", Other: "Other", Used: "Used", Free: "Free" };

function StorageBar({ store }: { store?: StorageInfo }) {
  if (!store) return <section className="storage-bar muted small">Reading storage…</section>;
  const used = store.segments.filter((s) => s.name !== "Free").reduce((a, s) => a + s.bytes, 0);
  return (
    <section className="storage-bar" aria-label="Device storage">
      <div className="storage-head">
        <h2>Device storage</h2>
        <span className="num">
          <strong>{gb(used)}</strong> used of {gb(store.totalBytes)}
        </span>
      </div>
      <div className="bar" role="img" aria-label={store.segments.map((s) => `${SEGMENT_LABEL[s.name]} ${gb(s.bytes)}`).join(", ")}>
        {store.segments.map((s) => (
          <span key={s.name} className={`seg seg-${s.name.toLowerCase()}`} style={{ flexGrow: s.bytes }} />
        ))}
      </div>
      <ul className="legend">
        {store.segments.map((s) => (
          <li key={s.name}>
            <span className={`swatch seg-${s.name.toLowerCase()}`} aria-hidden="true" />
            {SEGMENT_LABEL[s.name]} <span className="muted num">{gb(s.bytes)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HealthReport({ info, summary, onClose }: { info?: DeviceInfo; summary?: HomeSummary; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  const b = summary?.battery;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="report-title" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog report">
        <h3 id="report-title">Health report</h3>
        <div className="report-stats">
          <div>
            <span className="big num">{b?.health !== undefined ? `${b.health}%` : (b?.condition ?? "–")}</span>
            <span className="muted small">{b?.health !== undefined ? "Battery health (capacity vs new)" : "Battery condition"}</span>
          </div>
          <div>
            <span className="big num">{b?.cycles ?? "–"}</span>
            <span className="muted small">Charge cycles</span>
          </div>
          <div>
            <span className="big num">{b?.level !== undefined ? `${b.level}%` : "–"}</span>
            <span className="muted small">{b?.charging ? "Charge, charging now" : "Charge"}</span>
          </div>
        </div>
        {info && (
          <dl className="details">
            {info.fields.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="row end">
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
