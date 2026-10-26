export type Platform = "ios" | "android";

/** ready = usable; untrusted = user must accept the Trust / USB-debugging prompt on the phone. */
export type DeviceState = "ready" | "untrusted" | "offline";

export interface Device {
  id: string;
  platform: Platform;
  name: string;
  state: DeviceState;
}

export interface DeviceInfo {
  id: string;
  platform: Platform;
  /** Human labels → values, in display order. */
  fields: [string, string][];
}

export interface DeviceListResult {
  devices: Device[];
  /** Tool failures that hide devices, e.g. missing Apple driver on Windows. */
  errors: string[];
}

export interface StorageSegment {
  name: "System" | "Apps" | "Photos" | "Other" | "Used" | "Free";
  bytes: number;
}

export interface Battery {
  /** Charge, 0–100. */
  level?: number;
  /** Full-charge capacity as % of design (iPhone). */
  health?: number;
  cycles?: number;
  charging?: boolean;
  /** Android's own wording, e.g. "Good", "Overheat". */
  condition?: string;
}

/** Everything the Home page shows, gathered in one call. Each part is optional: a phone may refuse one query. */
export interface HomeSummary {
  modelName?: string;
  osVersion?: string;
  battery?: Battery;
  /** Photos app view (not deleted or hidden); recent = phone paths of the newest photos, for thumbnails. */
  photos?: { count: number; bytes: number; recent: string[] };
  apps?: { count: number; bytes?: number; largest?: { name: string; bytes: number }[] };
  /** From the newest backup on this computer, when it is readable. */
  contacts?: number;
  conversations?: number;
  lastBackup?: { date?: string; encrypted: boolean; locked: boolean };
}

export interface StorageInfo {
  /** Bottom-to-top order for the phone graphic; Free is last. */
  segments: StorageSegment[];
  totalBytes: number;
}

export interface DeviceApi {
  list(): Promise<DeviceListResult>;
  info(platform: Platform, id: string): Promise<DeviceInfo>;
  storage(platform: Platform, id: string): Promise<StorageInfo>;
  summary(platform: Platform, id: string): Promise<HomeSummary>;
  /** Confirms in a native dialog first; false = declined. */
  power(platform: Platform, id: string, action: "restart" | "shutdown"): Promise<boolean>;
  pair(platform: Platform, id: string): Promise<string>;
}

export interface AppInfo {
  /** Bundle id (iPhone) or package name (Android). */
  id: string;
  name: string;
  version?: string;
  /** The app itself; reinstalled from the store, never in backups. Unknown on Android. */
  appBytes?: number;
  /** Documents, settings and caches. */
  dataBytes?: number;
}

/** One item in the iPhone's Photos library (read from its library database over USB). */
export interface PhotoAsset {
  /** Library row id; stable while the library isn't rebuilt. */
  id: number;
  /** File path on the phone, relative to its media root, e.g. "DCIM/100APPLE/IMG_0001.HEIC". */
  path: string;
  /** Name it had when taken or saved, e.g. "IMG_0001.HEIC". */
  name: string;
  kind: "photo" | "video";
  /** ISO 8601. */
  date?: string;
  bytes?: number;
  width?: number;
  height?: number;
  /** Seconds, for videos. */
  duration?: number;
  live: boolean;
  screenshot: boolean;
  favorite: boolean;
  hidden: boolean;
  deleted: boolean;
  albums: number[];
}

export interface PhotoAlbum {
  id: number;
  title: string;
  count: number;
}

export interface PhotoDeleteResult {
  deleted: number;
  /** Not stored on the phone (iCloud only, or hidden from the camera connection). */
  notOnPhone: number;
  /** Couldn't be told apart from another item, or the phone refused. */
  skipped: number;
}

export interface PhotoLibrary {
  assets: PhotoAsset[];
  albums: PhotoAlbum[];
  /** Asset ids grouped as likely duplicates (same size and dimensions). */
  duplicates: number[][];
}

export interface LabeledValue {
  label: string;
  value: string;
}

export interface Contact {
  id: number;
  name: string;
  organization?: string;
  phones: LabeledValue[];
  emails: LabeledValue[];
}

export interface Conversation {
  id: number;
  /** Group name, or the other people's names (from contacts) or numbers. */
  title: string;
  participants: string[];
  messages: number;
  lastDate?: string;
  service?: string;
}

export interface ChatMessage {
  id: number;
  date?: string;
  fromMe: boolean;
  /** Name from contacts, else number or email; undefined for my own messages. */
  sender?: string;
  text: string;
  attachments: string[];
}

/** Image URL for a phone photo's thumbnail, served by the main process from its local copy. */
export const iconUrl = (deviceId: string, bundleId: string) => `ddthumb://${encodeURIComponent(deviceId)}/__icon/${encodeURIComponent(bundleId)}`;
/** Full-size viewable copy, after manage.previewMedia prepared it. */
export const mediaUrl = (deviceId: string, phonePath: string) => `ddthumb://${encodeURIComponent(deviceId)}/__full/${phonePath.split("/").map(encodeURIComponent).join("/")}`;
export const thumbUrl = (deviceId: string, phonePath: string) => `ddthumb://${encodeURIComponent(deviceId)}/${phonePath.split("/").map(encodeURIComponent).join("/")}`;

/** Modules that open in their own window. */
export interface ModulesApi {
  openTransfer(): Promise<void>;
  /** Saves the phone's screen into Pictures/Mobile Care Plus and reveals it; returns the file. */
  screenshot(platform: Platform, id: string, deviceName: string): Promise<string>;
}

export interface ManageApi {
  apps(platform: Platform, id: string): Promise<AppInfo[]>;
  /** One confirmation for all, then uninstalls; returns how many were removed (0 = declined). */
  uninstall(platform: Platform, id: string, apps: Pick<AppInfo, "id" | "name">[]): Promise<number>;
  /** Fetches app icons into the local cache; returns the ids that have one (show with iconUrl). */
  appIcons(platform: Platform, id: string, bundleIds: string[]): Promise<string[]>;
  /** Reads the phone's Photos library (refreshing the local copy when it changed). */
  photoLibrary(platform: Platform, id: string): Promise<PhotoLibrary>;
  /** Asks for a destination folder, then copies the originals in a task; false = no folder chosen. */
  exportPhotos(id: string, assetIds: number[]): Promise<boolean>;
  /** Copies one original from the phone so mediaUrl can show it. */
  previewMedia(id: string, assetId: number): Promise<void>;
  /** Asks first, then deletes from the iPhone; undefined = declined. */
  deletePhotos(id: string, assetIds: number[]): Promise<PhotoDeleteResult | undefined>;
  /** Read from an unencrypted backup (sourceId = backup folder). */
  contacts(sourceId: string): Promise<Contact[]>;
  /** Asks where to save; false = cancelled. */
  exportContacts(sourceId: string, format: "vcf" | "csv"): Promise<boolean>;
  conversations(sourceId: string): Promise<Conversation[]>;
  messages(sourceId: string, chatId: number): Promise<ChatMessage[]>;
  exportConversation(sourceId: string, chatId: number): Promise<boolean>;
}

export type TaskState = "running" | "done" | "failed" | "cancelled";

export interface Task {
  id: number;
  deviceId: string;
  title: string;
  state: TaskState;
  /** 0–100 when the tool reports it. */
  progress?: number;
  /** What the tool is doing right now, e.g. "Receiving files · 1.2 GB received". */
  detail?: string;
  /** Set when a finished task produced files; the task center offers to show them. */
  hasResult?: boolean;
  message?: string;
}

export interface BackupCategory {
  name: string;
  files: number;
  bytes: number;
}

export type BackupContents =
  | { kind: "ok"; categories: BackupCategory[]; apps: number }
  | { kind: "encrypted" };

export interface Backup {
  /** Folder name = UDID of the iPhone it came from. */
  sourceId: string;
  deviceName: string;
  productType?: string;
  iosVersion?: string;
  /** ISO 8601. */
  date?: string;
  encrypted: boolean;
  sizeBytes: number;
  path: string;
}

export interface RestoreOptions {
  sourceId: string;
  /** Needed when the backup is encrypted. Used once, never stored. */
  password?: string;
}

/** Types "Choose what to save" can write as normal files. The last three exist only in encrypted backups. */
export type AndroidSaveType = "photos" | "contacts" | "calendars";
export interface AndroidSaveCounts {
  photos?: { count: number; bytes: number };
  contacts?: number;
  events?: number;
}
export interface AndroidSavedFolder {
  dir: string;
  name: string;
  date: string;
  photos: number;
  contacts: boolean;
  calendars: number;
}
export type SaveType = "photos" | "contacts" | "messages" | "notes" | "calendars" | "bookmarks" | "calls" | "safariHistory" | "health";

/** Error messages starting with this mean "ask for the backup password, then retry". */
export const BACKUP_LOCKED = "Backup locked: ";

export interface BackupApi {
  /** The personal-data cache (messages, contacts, chat apps) for this phone, if it has been loaded. */
  personalData(deviceId: string): Promise<Backup | null>;
  /** "Load from iPhone": fills the cache, keeping only personal data. Progress arrives through onTasks. */
  loadPersonalData(deviceId: string): Promise<void>;
  /** Folder "Choose what to save" writes into. */
  saveFolder(): Promise<string>;
  /** Native folder picker; returns the new folder, or undefined when cancelled. */
  pickSaveFolder(): Promise<string | undefined>;
  /** Backs up (changes only), then saves the chosen types as files, in a task. */
  saveSelected(deviceId: string, types: SaveType[], password?: string): Promise<void>;
  /** What an Android phone has to save. */
  androidCounts(deviceId: string): Promise<AndroidSaveCounts>;
  /** Saves the chosen types off an Android phone as files, in a task. */
  saveAndroid(deviceId: string, deviceName: string, types: AndroidSaveType[]): Promise<void>;
  /** Export folders found in the save folder. */
  androidSaves(): Promise<AndroidSavedFolder[]>;
  revealAndroidSave(dir: string): Promise<void>;
  /** Puts a save back on the phone, in a task; contacts and calendars need a tap on its screen. */
  /** Asks first; false = declined. */
  restoreAndroidSave(dir: string, deviceId: string, deviceName: string): Promise<boolean>;
  /** Unlocks an encrypted backup for this session; the password isn't kept. */
  unlock(sourceId: string, password: string): Promise<void>;
  isUnlocked(sourceId: string): Promise<boolean>;
  list(): Promise<Backup[]>;
  /** What a backup holds, grouped into categories. */
  contents(sourceId: string): Promise<BackupContents>;
  /** Starts a task; progress arrives through onTasks. */
  start(deviceId: string): Promise<void>;
  /** Asks for confirmation in a native dialog first; false = user declined. */
  restore(deviceId: string, options: RestoreOptions): Promise<boolean>;
  encryption(deviceId: string): Promise<boolean>;
  setEncryption(deviceId: string, on: boolean, password: string): Promise<void>;
  /** Moves the backup to the Trash / Recycle Bin after confirmation. */
  remove(sourceId: string): Promise<boolean>;
  reveal(sourceId: string): Promise<void>;
}

export interface TaskApi {
  cancel(id: number): Promise<void>;
  /** Shows a finished task's files in Finder / Explorer. */
  reveal(id: number): Promise<void>;
  /** Returns an unsubscribe function. */
  onTasks(listener: (tasks: Task[]) => void): () => void;
}
