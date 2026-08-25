const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clippy", {
  run: (goal) => ipcRenderer.invoke("clippy:run", goal),
  look: () => ipcRenderer.invoke("clippy:look"),
  edit: (ref, value) => ipcRenderer.invoke("clippy:edit", { ref, value }),
  answerGate: (approved) => ipcRenderer.send("clippy:gate-answer", approved),
  pointerOver: (over) => ipcRenderer.send("clippy:pointer-over", over),
  resize: (open) => ipcRenderer.invoke("clippy:resize", open),
  move: (dx, dy) => ipcRenderer.send("clippy:move", { dx, dy }),
  onState: (fn) => ipcRenderer.on("clippy:state", (_e, p) => fn(p)),
  onStep: (fn) => ipcRenderer.on("clippy:step", (_e, p) => fn(p)),
  onGate: (fn) => ipcRenderer.on("clippy:gate", (_e, p) => fn(p)),
  onSummon: (fn) => ipcRenderer.on("clippy:summon", () => fn()),
});
