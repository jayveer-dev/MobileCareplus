import { contextBridge, ipcRenderer } from "electron";
import type { Task, TaskApi } from "../shared/types";

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("phoneSwitch", { summary: call("switch:summary"), move: call("switch:move") });
contextBridge.exposeInMainWorld("transfer", {
  devices: call("devices:list"),
  data: { status: call("data:status"), load: call("data:load"), unlock: call("data:unlock") },
  wa: {
    saved: call("wa:saved"),
    chats: call("wa:chats"),
    messages: call("wa:messages"),
    backup: call("wa:backup"),
    export: call("wa:export"),
    android: call("wa:android"),
    androidBackup: call("wa:androidBackup"),
    androidOpen: call("wa:androidOpen"),
  },
});

// Same task API as the main app, so its progress card can be reused.
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
contextBridge.exposeInMainWorld("tasks", tasks);
