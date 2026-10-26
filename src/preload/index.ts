import { contextBridge, ipcRenderer } from "electron";
import type { BackupApi, DeviceApi, ManageApi, ModulesApi, Task, TaskApi } from "../shared/types";

const devices: DeviceApi = {
  list: () => ipcRenderer.invoke("devices:list"),
  info: (platform, id) => ipcRenderer.invoke("devices:info", platform, id),
  storage: (platform, id) => ipcRenderer.invoke("devices:storage", platform, id),
  summary: (platform, id) => ipcRenderer.invoke("devices:summary", platform, id),
  power: (platform, id, action) => ipcRenderer.invoke("devices:power", platform, id, action),
  pair: (platform, id) => ipcRenderer.invoke("devices:pair", platform, id),
};

const backups: BackupApi = {
  list: () => ipcRenderer.invoke("backups:list"),
  personalData: (id) => ipcRenderer.invoke("backups:personalData", id),
  loadPersonalData: (id) => ipcRenderer.invoke("backups:loadPersonalData", id),
  saveFolder: () => ipcRenderer.invoke("backups:saveFolder"),
  pickSaveFolder: () => ipcRenderer.invoke("backups:pickSaveFolder"),
  saveSelected: (id, types, password) => ipcRenderer.invoke("backups:saveSelected", id, types, password),
  androidCounts: (id) => ipcRenderer.invoke("backups:androidCounts", id),
  saveAndroid: (id, name, types) => ipcRenderer.invoke("backups:saveAndroid", id, name, types),
  androidSaves: () => ipcRenderer.invoke("backups:androidSaves"),
  revealAndroidSave: (dir) => ipcRenderer.invoke("backups:revealAndroidSave", dir),
  restoreAndroidSave: (dir, id, name) => ipcRenderer.invoke("backups:restoreAndroidSave", dir, id, name),
  unlock: (sourceId, password) => ipcRenderer.invoke("backups:unlock", sourceId, password),
  isUnlocked: (sourceId) => ipcRenderer.invoke("backups:isUnlocked", sourceId),
  contents: (sourceId) => ipcRenderer.invoke("backups:contents", sourceId),
  start: (id) => ipcRenderer.invoke("backups:start", id),
  restore: (id, options) => ipcRenderer.invoke("backups:restore", id, options),
  encryption: (id) => ipcRenderer.invoke("backups:encryption", id),
  setEncryption: (id, on, password) => ipcRenderer.invoke("backups:setEncryption", id, on, password),
  remove: (sourceId) => ipcRenderer.invoke("backups:remove", sourceId),
  reveal: (sourceId) => ipcRenderer.invoke("backups:reveal", sourceId),
};

const manage: ManageApi = {
  apps: (platform, id) => ipcRenderer.invoke("manage:apps", platform, id),
  uninstall: (platform, id, apps) => ipcRenderer.invoke("manage:uninstall", platform, id, apps),
  appIcons: (platform, id, bundleIds) => ipcRenderer.invoke("manage:appIcons", platform, id, bundleIds),
  photoLibrary: (platform, id) => ipcRenderer.invoke("manage:photoLibrary", platform, id),
  exportPhotos: (id, assetIds) => ipcRenderer.invoke("manage:exportPhotos", id, assetIds),
  previewMedia: (id, assetId) => ipcRenderer.invoke("manage:previewMedia", id, assetId),
  deletePhotos: (id, assetIds) => ipcRenderer.invoke("manage:deletePhotos", id, assetIds),
  contacts: (sourceId) => ipcRenderer.invoke("manage:contacts", sourceId),
  exportContacts: (sourceId, format) => ipcRenderer.invoke("manage:exportContacts", sourceId, format),
  conversations: (sourceId) => ipcRenderer.invoke("manage:conversations", sourceId),
  messages: (sourceId, chatId) => ipcRenderer.invoke("manage:messages", sourceId, chatId),
  exportConversation: (sourceId, chatId) => ipcRenderer.invoke("manage:exportConversation", sourceId, chatId),
};

const tasks: TaskApi = {
  cancel: (id) => ipcRenderer.invoke("tasks:cancel", id),
  reveal: (id) => ipcRenderer.invoke("tasks:reveal", id),
  onTasks: (listener) => {
    const handler = (_e: unknown, list: Task[]) => listener(list);
    ipcRenderer.on("tasks:update", handler);
    ipcRenderer.invoke("tasks:list").then(listener);
    return () => ipcRenderer.removeListener("tasks:update", handler);
  },
};

contextBridge.exposeInMainWorld("devices", devices);
contextBridge.exposeInMainWorld("backups", backups);
contextBridge.exposeInMainWorld("manage", manage);
contextBridge.exposeInMainWorld("tasks", tasks);
contextBridge.exposeInMainWorld("modules", {
  openTransfer: () => ipcRenderer.invoke("modules:openTransfer"),
  screenshot: (platform, id, name) => ipcRenderer.invoke("tools:screenshot", platform, id, name),
} satisfies ModulesApi);
