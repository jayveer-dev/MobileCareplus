import { useEffect, useMemo, useState } from "react";
import { mediaUrl, type PhotoAsset, type PhotoDeleteResult, type PhotoLibrary, thumbUrl } from "../../shared/types";
import { Icon } from "./Icons";

/** Which slice of the library is shown; album views carry the album id. */
export type PhotoView = "library" | "videos" | "live" | "screenshots" | "favorites" | "hidden" | "deleted" | "duplicates" | `album:${number}`;

type Grouping = "year" | "month" | "day";

const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** Items in a view. Everything except Hidden and Recently Deleted leaves those two out, as the Photos app does. */
export function photosIn(library: PhotoLibrary, view: PhotoView): PhotoAsset[] {
  const shown = library.assets.filter((a) => !a.deleted && !a.hidden);
  if (view === "hidden") return library.assets.filter((a) => a.hidden && !a.deleted);
  if (view === "deleted") return library.assets.filter((a) => a.deleted);
  if (view === "videos") return shown.filter((a) => a.kind === "video");
  if (view === "live") return shown.filter((a) => a.live);
  if (view === "screenshots") return shown.filter((a) => a.screenshot);
  if (view === "favorites") return shown.filter((a) => a.favorite);
  if (view === "duplicates") {
    const ids = new Set(library.duplicates.flat());
    return shown.filter((a) => ids.has(a.id));
  }
  if (view.startsWith("album:")) {
    const album = Number(view.slice(6));
    return shown.filter((a) => a.albums.includes(album));
  }
  return shown;
}

const TITLES: Record<string, string> = {
  library: "Library",
  videos: "Videos",
  live: "Live Photos",
  screenshots: "Screenshots",
  favorites: "Favorites",
  hidden: "Hidden",
  deleted: "Recently Deleted",
  duplicates: "Possible duplicates",
};

const NOTES: Record<string, string> = {
  deleted: "iOS removes these for good about 30 days after they were deleted. Export any you want to keep.",
  duplicates: "Items with the same file size and dimensions. Check them before deleting on the iPhone.",
  hidden: "Shown only while the Hidden album is unlocked on the iPhone.",
};

const clean = (e: Error) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function deleteSummary(r: PhotoDeleteResult, android: boolean) {
  const parts = [android ? `Moved ${plural(r.deleted, "item")} to the phone's Trash (the Gallery keeps them about 30 days).` : `Deleted ${plural(r.deleted, "item")} from the iPhone.`];
  if (r.notOnPhone) parts.push(`${plural(r.notOnPhone, "item")} ${r.notOnPhone === 1 ? "is" : "are"} stored only in iCloud and ${r.notOnPhone === 1 ? "was" : "were"} left alone.`);
  if (r.skipped) parts.push(`${plural(r.skipped, "item")} couldn't be matched safely and ${r.skipped === 1 ? "was" : "were"} left alone.`);
  return parts.join(" ");
}

function groupKey(date: string | undefined, by: Grouping) {
  if (!date) return "Unknown date";
  const d = new Date(date);
  if (by === "year") return String(d.getFullYear());
  if (by === "month") return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "long", year: "numeric" });
}

export function Photos({ deviceId, platform, library, view, onRefresh, refreshing }: {
  deviceId: string;
  platform: "ios" | "android";
  library: PhotoLibrary;
  view: PhotoView;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const android = platform === "android";
  const [grouping, setGrouping] = useState<Grouping>("month");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [open, setOpen] = useState<number>();
  const [deleting, setDeleting] = useState(false);

  const items = useMemo(() => photosIn(library, view), [library, view]);
  const groups = useMemo(() => {
    const out = new Map<string, PhotoAsset[]>();
    for (const a of items) {
      const k = groupKey(a.date, grouping);
      out.set(k, [...(out.get(k) ?? []), a]);
    }
    return [...out.entries()];
  }, [items, grouping]);

  const title = view.startsWith("album:") ? (library.albums.find((a) => `album:${a.id}` === view)?.title ?? "Album") : TITLES[view];
  const selected = items.filter((a) => picked.has(a.id));
  const toggle = (ids: number[], on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const exportItems = (ids: number[]) => window.manage.exportPhotos(deviceId, ids).catch((e: Error) => setError(clean(e)));
  const deleteItems = async (ids: number[]) => {
    setError(undefined);
    setNote(undefined);
    setDeleting(true);
    try {
      const result = await window.manage.deletePhotos(deviceId, ids);
      if (!result) return;
      setNote(deleteSummary(result, android));
      setOpen(undefined);
      setPicked(new Set());
      onRefresh();
    } catch (e) {
      setError(clean(e as Error));
    } finally {
      setDeleting(false);
    }
  };
  const canDelete = view !== "deleted";
  const openIndex = open === undefined ? -1 : items.findIndex((a) => a.id === open);

  return (
    <div className="photos">
      <header className="photos-head">
        <h1>{title}</h1>
        <div className="segmented" role="group" aria-label="Group by">
          {(["year", "month", "day"] as const).map((g) => (
            <button key={g} aria-pressed={grouping === g} onClick={() => setGrouping(g)}>
              {g[0].toUpperCase() + g.slice(1)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="secondary" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      {NOTES[view] && <p className="muted small photos-note">{NOTES[view]}</p>}
      {error && <p className="error">{error}</p>}
      {note && <p className="callout">{note}</p>}
      {items.length === 0 && <p className="muted">Nothing here.</p>}

      <div className="photo-groups">
        {groups.map(([label, list]) => {
          const ids = list.map((a) => a.id);
          const all = ids.every((id) => picked.has(id));
          return (
            <section key={label} className="photo-group">
              <h2>
                <label className="toggle">
                  <input type="checkbox" checked={all} onChange={() => toggle(ids, !all)} aria-label={`Select all from ${label}`} />
                  {label}
                </label>
                <span className="pill">{list.length}</span>
              </h2>
              <ul className="tiles">
                {list.map((a) => {
                  const on = picked.has(a.id);
                  return (
                    <li key={a.id}>
                      <button
                        className={`tile ${on ? "on" : ""}`}
                        aria-pressed={on}
                        aria-label={`${a.kind === "video" ? "Video" : "Photo"} ${a.name}${a.date ? `, ${new Date(a.date).toLocaleString()}` : ""}`}
                        onClick={() => toggle([a.id], !on)}
                        onDoubleClick={() => setOpen(a.id)}
                      >
                        <img src={thumbUrl(deviceId, a.path)} alt="" loading="lazy" decoding="async" />
                        <span className="tile-check" aria-hidden="true" />
                        {a.kind === "video" && <span className="tile-badge num">▶ {a.duration ? clock(a.duration) : ""}</span>}
                        {a.live && <span className="tile-badge">Live</span>}
                      </button>
                      <button className="tile-open" onClick={() => setOpen(a.id)} aria-label={`View ${a.name}`} title="View">
                        <Icon name="expand" size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      <footer className="photos-bar">
        <label className="toggle">
          <input
            type="checkbox"
            checked={items.length > 0 && selected.length === items.length}
            onChange={() => toggle(items.map((a) => a.id), selected.length !== items.length)}
            aria-label="Select everything in this view"
          />
          Selected {selected.length.toLocaleString()} of {items.length.toLocaleString()}
          {selected.length > 0 && <span className="muted"> · {size(selected.reduce((s, a) => s + (a.bytes ?? 0), 0))}</span>}
        </label>
        <span className="spacer" />
        {selected.length > 0 && (
          <button className="secondary" onClick={() => setPicked(new Set())}>
            Clear
          </button>
        )}
        {canDelete && (
          <button className="secondary danger" disabled={selected.length === 0 || deleting} onClick={() => deleteItems(selected.map((a) => a.id))}>
            {deleting ? "Deleting…" : "Delete"}
          </button>
        )}
        <button disabled={selected.length === 0} onClick={() => exportItems(selected.map((a) => a.id))}>
          Export to computer
        </button>
      </footer>
      {openIndex >= 0 && (
        <Viewer
          deviceId={deviceId}
          items={items}
          index={openIndex}
          onIndex={(i) => setOpen(items[i].id)}
          onClose={() => setOpen(undefined)}
          onExport={(a) => exportItems([a.id])}
          onDelete={canDelete ? (a) => deleteItems([a.id]) : undefined}
          deleting={deleting}
        />
      )}
    </div>
  );
}

/** Full-size photo or video, copied from the phone on open; the thumbnail shows meanwhile. */
function Viewer({ deviceId, items, index, onIndex, onClose, onExport, onDelete, deleting }: {
  deviceId: string;
  items: PhotoAsset[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onExport: (a: PhotoAsset) => void;
  onDelete?: (a: PhotoAsset) => void;
  deleting: boolean;
}) {
  const a = items[index];
  const [ready, setReady] = useState<number>();
  const [error, setError] = useState<{ id: number; text: string }>();

  useEffect(() => {
    let live = true;
    window.manage.previewMedia(deviceId, a.id).then(
      () => live && setReady(a.id),
      (e: Error) => live && setError({ id: a.id, text: clean(e) }),
    );
    return () => {
      live = false;
    };
  }, [deviceId, a.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onClose, onIndex]);

  const shown = ready === a.id;
  const failed = error?.id === a.id ? error.text : undefined;
  const facts = [a.date && new Date(a.date).toLocaleString(), a.bytes && size(a.bytes), a.width && a.height && `${a.width} × ${a.height}`, a.duration && clock(a.duration)].filter(Boolean);

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={a.name}>
      <header className="viewer-bar">
        <div className="viewer-title">
          <strong>{a.name}</strong>
          <span>{facts.join("  ·  ")}</span>
        </div>
        <span className="spacer" />
        <span className="viewer-count num">
          {index + 1} of {items.length}
        </span>
        <button className="secondary" onClick={() => onExport(a)}>
          Export
        </button>
        {onDelete && (
          <button className="secondary danger" disabled={deleting} onClick={() => onDelete(a)}>
            {deleting ? "Deleting…" : "Delete"}
          </button>
        )}
        <button className="viewer-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <div className="viewer-stage">
        <button className="viewer-nav prev" disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Previous">
          <Icon name="chevron" size={22} />
        </button>
        {shown && a.kind === "video" ? (
          <video key={a.id} src={mediaUrl(deviceId, a.path)} controls autoPlay />
        ) : (
          <img key={a.id} src={shown ? mediaUrl(deviceId, a.path) : thumbUrl(deviceId, a.path)} alt={a.name} className={shown ? "" : "is-loading"} />
        )}
        {!shown && <p className="viewer-status">{failed ?? (a.kind === "video" ? "Copying the video from the phone…" : "Loading from the phone…")}</p>}
        <button className="viewer-nav next" disabled={index === items.length - 1} onClick={() => onIndex(index + 1)} aria-label="Next">
          <Icon name="chevron" size={22} />
        </button>
      </div>
    </div>
  );
}
