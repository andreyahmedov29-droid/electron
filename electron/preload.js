// Биотим Electron — preload. Открывает странице мост для печати через главный
// процесс: окно печати открывается НАТИВНО (в обход веб-песочницы, которая
// блокирует window.print()). Доступ осуществляется через contextBridge, поэтому
// работает даже при contextIsolation:true и во вложенной (sandbox) странице.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("printStickerBridge", {
  print: (html) => ipcRenderer.send("print-sticker", html || ""),
});
