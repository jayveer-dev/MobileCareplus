import { useEffect, useState } from "react";
import type { Device, Platform } from "../../../shared/types";
import { Icon, type IconName } from "../Icons";
import { kind, PhonePair, usePhonePair } from "./PhonePair";

interface Phone {
  platform: Platform;
  id: string;
  name: string;
}
interface Summary {
  photos?: { count: number; bytes: number };
  contacts?: number;
  events?: number;
  needsLoad?: boolean;
}
declare global {
  interface Window {
    phoneSwitch: {
      summary(source: Phone): Promise<Summary>;
      move(what: ItemId[], source: Phone, dest: Phone): Promise<void>;
    };
  }
}

/** For one direction: ready to move, coming next, or not something phones allow. */
type Can = { status: "ready"; tap?: boolean } | { status: "next" | "no" | "elsewhere"; why: string };
type ItemId = "photos" | "contacts" | "calendar" | "files" | "apps" | "messages" | "chats";

interface Item {
  id: ItemId;
  title: string;
  icon: IconName;
  can: (from: Platform, to: Platform) => Can;
}

const toIphoneLater = "Moving this into an iPhone is being worked on.";
// The one place that says what can move in each direction; the checklist only reads it.
const ITEMS: Item[] = [
  { id: "photos", title: "Photos & videos", icon: "photo", can: (_f, to) => (to === "android" ? { status: "ready" } : { status: "next", why: "iPhones only add photos to the Photos app through Apple's own sync. Being worked on." }) },
  { id: "contacts", title: "Contacts", icon: "contact", can: (_f, to) => (to === "android" ? { status: "ready", tap: true } : { status: "next", why: toIphoneLater }) },
  { id: "calendar", title: "Calendar", icon: "book", can: (_f, to) => (to === "android" ? { status: "ready", tap: true } : { status: "next", why: toIphoneLater }) },
  { id: "files", title: "Music, documents and downloads", icon: "folder", can: (_f, to) => ({ status: "next", why: to === "android" ? "Next: copied into the same folders on the new phone." : "Next: into the iPhone's Files app." }) },
  {
    id: "apps",
    title: "Apps",
    icon: "apps",
    can: (from, to) =>
      to === "ios"
        ? { status: "no", why: "iPhones only install apps from the App Store." }
        : from === "android"
          ? { status: "next", why: "Next: reinstalls the same apps. Logins and app data stay behind." }
          : { status: "next", why: "Next: a list of the same apps to install from Google Play." },
  },
  { id: "messages", title: "Text messages and call history", icon: "message", can: () => ({ status: "next", why: "Later: needs a small helper app on the new phone." }) },
  { id: "chats", title: "WhatsApp and other chat apps", icon: "message", can: () => ({ status: "elsewhere", why: "Each chat app has its own transfer: go Back and pick the app." }) },
];

const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const asPhone = (d: Device): Phone => ({ platform: d.platform, id: d.id, name: d.name });

export function PhoneSwitch({ devices, onClose }: { devices: Device[]; onClose: () => void }) {
  const pair = usePhonePair(devices);
  const { source, dest } = pair;
  const [summary, setSummary] = useState<Summary>();
  const [picked, setPicked] = useState<Set<ItemId>>(new Set(["photos"]));
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const [started, setStarted] = useState(false);

  useEffect(() => {
    setSummary(undefined);
    setStarted(false);
    if (source?.state === "ready") window.phoneSwitch.summary(asPhone(source)).then(setSummary, () => setSummary({}));
  }, [source]);

  const both = source?.state === "ready" && dest?.state === "ready" && source.id !== dest.id;
  const can = (item: Item) => (source && dest ? item.can(source.platform, dest.platform) : undefined);
  const chosen = ITEMS.filter((i) => picked.has(i.id) && can(i)?.status === "ready");
  const detail = (item: Item) => {
    if (item.id === "photos") return summary?.photos && `${summary.photos.count.toLocaleString()} items, ${size(summary.photos.bytes)}`;
    if (item.id === "contacts") return summary?.needsLoad ? "Load the iPhone's data first (Manage › Contacts in the main app)." : summary?.contacts !== undefined ? `${summary.contacts.toLocaleString()} contacts · one tap to import on the new phone` : undefined;
    if (item.id === "calendar") return summary?.needsLoad ? "Load the iPhone's data first (Manage › Contacts in the main app)." : summary?.events !== undefined ? `${summary.events.toLocaleString()} events · one tap per calendar on the new phone` : undefined;
    return undefined;
  };

  const start = async () => {
    if (!source || !dest) return;
    setError(undefined);
    try {
      await window.phoneSwitch.move(chosen.map((i) => i.id), asPhone(source), asPhone(dest));
      setStarted(true);
    } catch (e) {
      setError(clean(e));
    }
  };

  return (
    <section className="xfer">
      <button className="quiet tx-back" onClick={onClose}>
        <span className="tx-back-icon">
          <Icon name="chevron" size={16} />
        </span>
        Back
      </button>
      <h1 className="tx-title sw-title">Move to a new phone</h1>
      <p className="muted xfer-explain">Connect both phones. Choose what to move; nothing is deleted from either phone.</p>

      <PhonePair devices={devices} pair={pair} labels={["Old phone", "New phone"]} />

      <section className="sw-list" aria-label="What to move">
        <h2 className="dash-title">{source && dest ? `What can move from ${kind(source)} to ${kind(dest)}` : "What can move"}</h2>
        <ul className="tx-actions">
          {ITEMS.map((item) => {
            const c = can(item);
            const ready = c?.status === "ready";
            return (
              <li key={item.id} aria-disabled={ready ? undefined : "true"}>
                <span className="quick-icon">
                  <Icon name={item.icon} />
                </span>
                <span className="tx-action-text">
                  <span className="quick-title">{item.title}</span>
                  <span className="muted small">{!c ? "Connect both phones to see." : ready ? (detail(item) ?? "Ready to move.") : c.why}</span>
                </span>
                {ready ? (
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={picked.has(item.id)}
                      onChange={() =>
                        setPicked((p) => {
                          const next = new Set(p);
                          if (next.has(item.id)) next.delete(item.id);
                          else next.add(item.id);
                          return next;
                        })
                      }
                      aria-label={`Move ${item.title}`}
                    />
                  </label>
                ) : (
                  c && <span className="tree-soon">{c.status === "no" ? "Not possible" : c.status === "elsewhere" ? "Separate" : "Coming"}</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <div className="xfer-foot">
        {error && <p className="error">{error}</p>}
        {started && <p className="callout">Started. Follow it in Tasks; it keeps going if you leave this screen.</p>}
        <button className="xfer-go" disabled={!both || chosen.length === 0} onClick={() => setConfirming(true)}>
          {chosen.length ? `Move ${chosen.length === 1 ? chosen[0].title.toLowerCase() : `${chosen.length} kinds of data`}` : "Choose what to move"}
        </button>
        {!both && <p className="muted small">{devices.length < 2 ? "Connect the other phone too." : "Choose two different phones that are unlocked and trusted."}</p>}
      </div>

      {confirming && source && dest && (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="sw-confirm">
          <div className="dialog xfer-checks">
            <h3 id="sw-confirm">
              {source.name} → {dest.name}
            </h3>
            <ul>
              {chosen.map((i) => (
                <li key={i.id} className="good">
                  <span className="xfer-mark" aria-hidden="true">
                    ✓
                  </span>
                  {i.title}
                  {detail(i) ? `: ${detail(i)}` : ""}
                </li>
              ))}
            </ul>
            <p className="muted">
              {chosen.some((i) => i.id === "photos") ? `Photos and videos go into an album called "${source.name}" on ${dest.name}. ` : ""}
              {chosen.some((i) => { const c = can(i); return c?.status === "ready" && c.tap; }) ? `Contacts and calendars open on ${dest.name} for you to confirm with a tap. ` : ""}
              Keep both phones connected and unlocked until it finishes. Nothing is deleted from either phone, and running it again only copies what's missing.
            </p>
            <div className="row end">
              <button className="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                onClick={() => {
                  setConfirming(false);
                  void start();
                }}
              >
                Start moving
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
