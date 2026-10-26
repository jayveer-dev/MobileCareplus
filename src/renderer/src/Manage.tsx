import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type AppInfo, type Backup, type ChatMessage, type Contact, type Conversation, type Device, iconUrl, type PhotoLibrary } from "../../shared/types";
import { PasswordDialog } from "./Backups";
import { Icon, type IconName } from "./Icons";
import { type PhotoView, Photos, photosIn } from "./Photos";

const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(bytes / 1e6, 0.1).toFixed(bytes >= 1e7 ? 0 : 1)} MB`);
const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** A place in the Manage menu: a photo view, or one of the other sections. */
type Place = { kind: "photos"; view: PhotoView } | { kind: "apps" } | { kind: "contacts" } | { kind: "messages" };

// Shown in the menu so the full set is visible; each opens a short "coming soon" note.
const SOON: [string, IconName, string][] = [
  ["Music", "music", "Songs and playlists on the iPhone, with copying of music that isn't copy-protected."],
  ["TV & videos", "film", "Videos added through the TV app."],
  ["Podcasts", "mic", "Downloaded podcast episodes."],
  ["Books", "book", "Books and PDFs saved in the Books app."],
  ["Bookmarks", "bookmark", "Safari bookmarks, to export or import into a browser."],
  ["Files", "folder", "Documents that apps share in the Files app."],
];

const ALBUMS_SHOWN = 6;

function placeFrom(initial: string | undefined, ios: boolean): Place {
  if (initial === "apps") return { kind: "apps" };
  if (ios && (initial === "contacts" || initial === "messages")) return { kind: initial };
  return { kind: "photos", view: "library" };
}

export function Manage({ device, initial }: { device: Device; initial?: string }) {
  const ios = device.platform === "ios";
  const [place, setPlace] = useState<Place>(() => placeFrom(initial, ios));
  const [library, setLibrary] = useState<PhotoLibrary>();
  const [libraryError, setLibraryError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [photosOpen, setPhotosOpen] = useState(true);
  const [allAlbums, setAllAlbums] = useState(false);
  const [soon, setSoon] = useState<string>();
  const [appCount, setAppCount] = useState<number>();

  const loadLibrary = useCallback(() => {
    setRefreshing(true);
    window.manage
      .photoLibrary(device.platform, device.id)
      .then(setLibrary, (e) => setLibraryError(cleanError(e)))
      .finally(() => setRefreshing(false));
  }, [device.id, device.platform]);
  useEffect(() => {
    if (device.state === "ready") loadLibrary();
    window.manage.apps(device.platform, device.id).then((a) => setAppCount(a.length), () => {});
  }, [device.state, device.platform, device.id, loadLibrary]);

  if (device.state !== "ready") return <p className="empty-note">Unlock the phone and trust this computer to manage its files.</p>;

  const count = (view: PhotoView) => (library ? photosIn(library, view).length : undefined);
  const go = (p: Place) => {
    setSoon(undefined);
    setPlace(p);
  };
  const isPhotoView = (v: PhotoView) => !soon && place.kind === "photos" && place.view === v;
  const PhotoItem = ({ view, label, icon }: { view: PhotoView; label: string; icon: IconName }) => (
    <button className="tree-leaf" aria-current={isPhotoView(view) ? "page" : undefined} onClick={() => go({ kind: "photos", view })}>
      <Icon name={icon} size={17} />
      <span className="tree-label">{label}</span>
      <span className="tree-count num">{count(view)?.toLocaleString()}</span>
    </button>
  );

  return (
    <div className="manage">
      <nav className="tree" aria-label="Manage">
        <button className="tree-root" aria-expanded={photosOpen} onClick={() => setPhotosOpen((o) => !o)}>
          <span className="tree-icon ti-photos">
            <Icon name="photo" size={17} />
          </span>
          <span className="tree-label">Photos</span>
          <span className={`tree-caret ${photosOpen ? "open" : ""}`}>
            <Icon name="chevron" size={15} />
          </span>
        </button>
        {photosOpen && (
          <div className="tree-children">
            <PhotoItem view="library" label="Library" icon="photo" />
            <PhotoItem view="videos" label="Videos" icon="film" />
            {ios && <PhotoItem view="live" label="Live Photos" icon="live" />}
            <PhotoItem view="screenshots" label="Screenshots" icon="screenshot" />
            <PhotoItem view="favorites" label="Favorites" icon="heart" />
            {ios && <PhotoItem view="hidden" label="Hidden" icon="hidden" />}
            {ios && <PhotoItem view="deleted" label="Recently Deleted" icon="trash" />}
            <PhotoItem view="duplicates" label="Duplicates" icon="copy" />
            {/* Albums (Android: folders) last; there can be dozens, so the biggest few first. */}
            {library?.albums.slice(0, allAlbums ? undefined : ALBUMS_SHOWN).map((a) => (
              <PhotoItem key={a.id} view={`album:${a.id}`} label={a.title} icon="album" />
            ))}
            {library && library.albums.length > ALBUMS_SHOWN && (
              <button className="tree-leaf tree-more" onClick={() => setAllAlbums((v) => !v)}>
                <span className="tree-label muted">{allAlbums ? "Fewer albums" : `${library.albums.length - ALBUMS_SHOWN} more albums`}</span>
              </button>
            )}
          </div>
        )}
        {ios && (
          <>
            <button className="tree-root" aria-current={!soon && place.kind === "contacts" ? "page" : undefined} onClick={() => go({ kind: "contacts" })}>
              <span className="tree-icon ti-contacts">
                <Icon name="contact" size={17} />
              </span>
              <span className="tree-label">Contacts</span>
            </button>
            <button className="tree-root" aria-current={!soon && place.kind === "messages" ? "page" : undefined} onClick={() => go({ kind: "messages" })}>
              <span className="tree-icon ti-messages">
                <Icon name="message" size={17} />
              </span>
              <span className="tree-label">Messages</span>
            </button>
          </>
        )}
        <button className="tree-root" aria-current={!soon && place.kind === "apps" ? "page" : undefined} onClick={() => go({ kind: "apps" })}>
          <span className="tree-icon ti-apps">
            <Icon name="apps" size={17} />
          </span>
          <span className="tree-label">Apps</span>
          <span className="tree-count num">{appCount?.toLocaleString()}</span>
        </button>
        {ios &&
          SOON.map(([name, icon]) => (
            <button key={name} className="tree-root is-soon" aria-current={soon === name ? "page" : undefined} onClick={() => setSoon(name)}>
              <span className="tree-icon">
                <Icon name={icon} size={17} />
              </span>
              <span className="tree-label">{name}</span>
              <span className="tree-soon">Soon</span>
            </button>
          ))}
      </nav>

      <section className="manage-body">
        {soon ? (
          <div className="soon-note">
            <h1>{soon}</h1>
            <p className="muted">{SOON.find(([n]) => n === soon)?.[2]} Coming in a later update.</p>
          </div>
        ) : place.kind === "photos" ? (
          libraryError ? (
            <p className="error">{libraryError}</p>
          ) : !library ? (
            <p className="muted">Reading the photo library from the phone… The first time takes a few seconds.</p>
          ) : (
            <Photos deviceId={device.id} platform={device.platform} library={library} view={place.view} onRefresh={loadLibrary} refreshing={refreshing} />
          )
        ) : place.kind === "apps" ? (
          <Apps device={device} onCount={setAppCount} />
        ) : (
          <FromBackup device={device}>
            {(backup) => (place.kind === "contacts" ? <Contacts backup={backup} /> : <Messages backup={backup} />)}
          </FromBackup>
        )}
      </section>
    </div>
  );
}

/** Two-letter stand-in while an icon loads or when the phone has none. */
const initials = (name: string) => name.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

function Apps({ device, onCount }: { device: Device; onCount: (n: number) => void }) {
  const [apps, setApps] = useState<AppInfo[]>();
  const [icons, setIcons] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await window.manage.apps(device.platform, device.id);
      setApps(list);
      onCount(list.length);
      // Android icons come from each app's package, a second or so per app the first time: show them in batches.
      const ids = list.map((a) => a.id);
      const batch = device.platform === "ios" ? ids.length : 8;
      for (let i = 0; i < ids.length; i += batch) {
        const got = await window.manage.appIcons(device.platform, device.id, ids.slice(i, i + batch));
        setIcons((s) => new Set([...s, ...got]));
      }
    } catch (e) {
      setError(cleanError(e));
    }
  }, [device.platform, device.id, onCount]);
  useEffect(() => {
    load();
  }, [load]);

  const uninstall = async (targets: AppInfo[]) => {
    setBusy(true);
    setError(undefined);
    try {
      if ((await window.manage.uninstall(device.platform, device.id, targets.map((a) => ({ id: a.id, name: a.name })))) > 0) {
        setPicked(new Set());
        await load();
      }
    } catch (e) {
      setError(cleanError(e));
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!apps) return error ? <p className="error">{error}</p> : <p className="muted">Reading installed apps…</p>;
  const q = query.trim().toLowerCase();
  const shown = q ? apps.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) : apps;
  const hasSizes = apps.some((a) => a.appBytes !== undefined);
  const total = (a: AppInfo) => (a.appBytes ?? 0) + (a.dataBytes ?? 0);
  const selected = apps.filter((a) => picked.has(a.id));
  const allShown = shown.length > 0 && shown.every((a) => picked.has(a.id));
  const toggle = (ids: string[], on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  return (
    <div className="apps-view">
      <header className="photos-head">
        <h1>My apps</h1>
        <span className="pill">{apps.length}</span>
        <span className="spacer" />
        <input type="search" className="search" placeholder="Search apps" aria-label="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="secondary" onClick={load} disabled={busy}>
          Refresh
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      <table className="grid apps-table">
        <thead>
          <tr>
            <th scope="col" className="check">
              <input type="checkbox" checked={allShown} onChange={() => toggle(shown.map((a) => a.id), !allShown)} aria-label="Select all apps shown" />
            </th>
            <th scope="col">App</th>
            <th scope="col">Version</th>
            {hasSizes && (
              <>
                <th scope="col" className="num">App size</th>
                <th scope="col" className="num">Data</th>
              </>
            )}
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((a) => (
            <tr key={a.id} className={picked.has(a.id) ? "picked" : ""}>
              <td className="check">
                <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle([a.id], !picked.has(a.id))} aria-label={`Select ${a.name}`} />
              </td>
              <td>
                <div className="app-cell">
                  {icons.has(a.id) ? <img className="app-icon" src={iconUrl(device.id, a.id)} alt="" /> : <span className="app-icon placeholder">{initials(a.name)}</span>}
                  <div>
                    <div className="app-name">{a.name}</div>
                    <div className="muted small">{a.id}</div>
                  </div>
                </div>
              </td>
              <td className="num">{a.version}</td>
              {hasSizes && (
                <>
                  <td className="num">{a.appBytes !== undefined ? size(a.appBytes) : ""}</td>
                  <td className="num">{a.dataBytes !== undefined ? size(a.dataBytes) : ""}</td>
                </>
              )}
              <td className="row-action">
                <button className="icon-button danger" disabled={busy} onClick={() => uninstall([a])} aria-label={`Uninstall ${a.name}`} title="Uninstall">
                  <Icon name="trash" size={18} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <p className="muted">No app matches "{query}".</p>}
      <footer className="photos-bar">
        <span>
          Selected {selected.length} of {apps.length}
          {hasSizes && selected.length > 0 && <span className="muted"> · {size(selected.reduce((s, a) => s + total(a), 0))} of {size(apps.reduce((s, a) => s + total(a), 0))}</span>}
        </span>
        <span className="spacer" />
        {selected.length > 0 && (
          <button className="secondary" onClick={() => setPicked(new Set())}>
            Clear
          </button>
        )}
        <button className="danger-fill" disabled={selected.length === 0 || busy} onClick={() => uninstall(selected)}>
          {busy ? "Removing…" : `Uninstall${selected.length ? ` ${selected.length}` : ""}`}
        </button>
      </footer>
    </div>
  );
}

const shortDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

const ago = (iso?: string) => {
  if (!iso) return "earlier";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} hours ago`;
  return new Date(iso).toLocaleString();
};

/**
 * Contacts and messages can't be read over USB directly: iOS only hands them out inside a whole-phone
 * backup, and the phone, not the computer, decides what a backup contains. (Its contacts sync service
 * only shares contacts stored "On My iPhone", missing Google/CardDAV/Exchange ones, so it isn't used.)
 * "Load from iPhone" runs that backup through the light load (src/main/lightLoad.ts), which keeps
 * only personal data; after the first load, only changes are copied.
 */
function FromBackup({ device, children }: { device: Device; children: (backup: Backup) => ReactNode }) {
  const [backup, setBackup] = useState<Backup | null>();
  const [unlocked, setUnlocked] = useState(false);
  const [asking, setAsking] = useState(false);
  const [loading, setLoading] = useState<{ progress?: number; detail?: string }>();
  const [error, setError] = useState<string>();
  const watching = useRef<number | undefined>(undefined);

  const find = useCallback(async () => {
    const b = await window.backups.personalData(device.id);
    if (b?.encrypted) setUnlocked(await window.backups.isUnlocked(b.sourceId));
    setBackup(b);
  }, [device.id]);
  useEffect(() => {
    find();
  }, [find]);

  // Follow this device's load (a backup task) and re-read when it finishes.
  useEffect(
    () =>
      window.tasks.onTasks((tasks) => {
        const t = tasks.find((x) => x.deviceId === device.id && (x.state === "running" || x.id === watching.current));
        if (!t) return;
        if (t.state === "running") {
          watching.current = t.id;
          setLoading({ progress: t.progress, detail: t.detail });
        } else if (watching.current === t.id) {
          watching.current = undefined;
          setLoading(undefined);
          if (t.state === "failed") setError(t.message ?? "Loading from the iPhone failed.");
          find();
        }
      }),
    [device.id, find],
  );

  const load = async () => {
    setError(undefined);
    setLoading({});
    try {
      await window.backups.loadPersonalData(device.id);
    } catch (e) {
      setLoading(undefined);
      setError(cleanError(e));
    }
  };

  const loadPanel = (intro: string) => (
    <div className="load-panel">
      <span className="quick-icon">
        <Icon name="save" />
      </span>
      <div>
        <p>{intro}</p>
        {loading ? (
          <>
            <progress max={100} value={loading.progress} aria-label="Loading from the iPhone" />
            <p className="muted small">{loading.detail ?? "Preparing on the iPhone… keep it unlocked and connected."}</p>
          </>
        ) : (
          <button onClick={load}>Load from iPhone</button>
        )}
        {error && <p className="error small">{error}</p>}
      </div>
    </div>
  );

  if (backup === undefined) return <p className="muted">Checking what's been loaded…</p>;
  if (!backup)
    return loadPanel(
      "The iPhone only shares messages and contacts inside a backup, so the first load takes a few minutes while it sends one. Mobile Care Plus keeps only your personal data (messages, contacts, notes, chat apps) and discards the rest as it arrives, so it doesn't store the whole phone. Later loads bring only what changed.",
    );
  if (backup.encrypted && !unlocked)
    return (
      <div className="callout">
        <p>This iPhone's data is encrypted (Encrypt backups is on). Enter the backup password to read it. Mobile Care Plus keeps it unlocked only until you quit, and never saves the password.</p>
        <button onClick={() => setAsking(true)}>Unlock</button>
        {asking && (
          <PasswordDialog
            request={{
              title: "Backup password",
              detail: "The password chosen when backup encryption was turned on. It isn't the iPhone passcode. Unlocking takes a few seconds.",
              submit: async (password) => {
                await window.backups.unlock(backup.sourceId, password).catch((e: Error) => Promise.reject(new Error(cleanError(e))));
                setUnlocked(true);
              },
            }}
            onClose={() => setAsking(false)}
          />
        )}
      </div>
    );
  return (
    <>
      <div className="source-note">
        <span className="muted small">Loaded from the iPhone {ago(backup.date)}.</span>
        {loading ? (
          <span className="muted small"> Loading changes… {loading.progress !== undefined ? `${Math.floor(loading.progress)}%` : ""}</span>
        ) : (
          <button className="link" onClick={load}>
            Load latest from iPhone
          </button>
        )}
        {error && <span className="error small"> {error}</span>}
      </div>
      {children(backup)}
    </>
  );
}

function Contacts({ backup }: { backup: Backup }) {
  const [contacts, setContacts] = useState<Contact[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  useEffect(() => {
    window.manage.contacts(backup.sourceId).then(setContacts, (e) => setError(cleanError(e)));
  }, [backup.sourceId, backup.date]);

  if (error) return <p className="error">{error}</p>;
  if (!contacts) return <p className="muted">Reading contacts…</p>;
  const q = query.trim().toLowerCase();
  const shown = q
    ? contacts.filter((c) => [c.name, c.organization ?? "", ...c.phones.map((p) => p.value), ...c.emails.map((e) => e.value)].join(" ").toLowerCase().includes(q))
    : contacts;
  const save = (format: "vcf" | "csv") => window.manage.exportContacts(backup.sourceId, format).catch((e) => setError(cleanError(e)));

  return (
    <div>
      <header className="section-head">
        <h1>Contacts</h1>
        <p className="muted">{contacts.length.toLocaleString()} contacts.</p>
      </header>
      <div className="toolbar">
        <input type="search" className="search" placeholder="Search contacts" aria-label="Search contacts" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="spacer" />
        <button className="secondary" onClick={() => save("csv")}>
          Export spreadsheet
        </button>
        <button onClick={() => save("vcf")}>Export vCard</button>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Phone</th>
            <th scope="col">Email</th>
          </tr>
        </thead>
        <tbody>
          {shown.slice(0, 500).map((c) => (
            <tr key={c.id}>
              <td>
                <div className="app-name">{c.name}</div>
                {c.organization && c.organization !== c.name && <div className="muted small">{c.organization}</div>}
              </td>
              <td className="phones">
                {c.phones.map((p) => (
                  <div key={p.value}>
                    {p.value} <span className="muted small">{p.label}</span>
                  </div>
                ))}
              </td>
              <td>{c.emails.map((e) => <div key={e.value}>{e.value}</div>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length > 500 && <p className="muted small">Showing the first 500. Search to narrow it down; exports include everyone.</p>}
    </div>
  );
}

function Messages({ backup }: { backup: Backup }) {
  const [chats, setChats] = useState<Conversation[]>();
  const [open, setOpen] = useState<Conversation>();
  const [thread, setThread] = useState<ChatMessage[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    window.manage.conversations(backup.sourceId).then((c) => {
      setChats(c);
      setOpen(c[0]);
    }, (e) => setError(cleanError(e)));
  }, [backup.sourceId, backup.date]);

  useEffect(() => {
    if (!open) return;
    setThread(undefined);
    window.manage.messages(backup.sourceId, open.id).then(setThread, (e) => setError(cleanError(e)));
  }, [backup.sourceId, open]);

  // Open each conversation at its newest message, like the Messages app.
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [thread]);

  if (error) return <p className="error">{error}</p>;
  if (!chats) return <p className="muted">Reading messages…</p>;
  if (chats.length === 0) return <p className="muted">No conversations in this backup. With Messages in iCloud turned on, they stay in iCloud.</p>;
  const q = query.trim().toLowerCase();
  const shown = q ? chats.filter((c) => `${c.title} ${c.participants.join(" ")}`.toLowerCase().includes(q)) : chats;

  return (
    <div>
      <header className="section-head">
        <h1>Messages</h1>
        <p className="muted">{chats.length.toLocaleString()} conversations, {chats.reduce((s, c) => s + c.messages, 0).toLocaleString()} messages.</p>
      </header>
      <div className="messages">
        <div className="chat-list">
          <input type="search" className="search" placeholder="Search conversations" aria-label="Search conversations" value={query} onChange={(e) => setQuery(e.target.value)} />
          <ul>
            {shown.map((c) => (
              <li key={c.id}>
                <button aria-current={open?.id === c.id ? "true" : undefined} onClick={() => setOpen(c)}>
                  <span className="chat-title">{c.title}</span>
                  <span className="muted small">
                    {c.messages.toLocaleString()} {c.messages === 1 ? "message" : "messages"}{c.lastDate && `, last ${shortDate(c.lastDate)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <section className="thread" aria-label={open ? `Conversation with ${open.title}` : "Conversation"}>
          {open && (
            <div className="thread-head">
              <h2>{open.title}</h2>
              <button className="secondary" onClick={() => window.manage.exportConversation(backup.sourceId, open.id).catch((e) => setError(cleanError(e)))}>
                Export conversation
              </button>
            </div>
          )}
          {!thread ? (
            <p className="muted">Loading…</p>
          ) : (
            <ol className="bubbles" ref={list}>
              {thread.slice(-400).map((m) => (
                <li key={m.id} className={m.fromMe ? "me" : "them"}>
                  <span className="meta">
                    {!m.fromMe && open && open.participants.length > 1 && m.sender ? `${m.sender}, ` : ""}
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
          {thread && thread.length > 400 && <p className="muted small">Showing the latest 400 messages. Export includes all {thread.length.toLocaleString()}.</p>}
        </section>
      </div>
    </div>
  );
}
