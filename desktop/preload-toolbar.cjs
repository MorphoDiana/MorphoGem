const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('morphogemDesktop', {
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  switchTab: (tab) => ipcRenderer.invoke('desktop:switch-tab', tab),
  openProjectsDir: () => ipcRenderer.invoke('desktop:open-projects'),
  openDownloadsDir: () => ipcRenderer.invoke('desktop:open-downloads'),
  chooseDownloadsDir: () => ipcRenderer.invoke('desktop:choose-downloads'),
  openModsDir: () => ipcRenderer.invoke('desktop:open-mods'),
  chooseBlenderExe: () => ipcRenderer.invoke('desktop:choose-blender'),
  notifyBlenderUpdated: (blenderPath) => ipcRenderer.invoke('desktop:notify-blender-updated', blenderPath),
  checkUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:download-update'),
  quitAndInstallUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  revealLastDownload: () => ipcRenderer.invoke('desktop:reveal-last-download'),
  copyMcpConfig: () => ipcRenderer.invoke('desktop:copy-mcp-config'),
  reloadActive: () => ipcRenderer.invoke('desktop:reload-active'),
  checkTripo: () => ipcRenderer.invoke('desktop:check-tripo'),
  tripoGoogleLogin: () => ipcRenderer.invoke('desktop:tripo-google-login'),
  onState: (cb) => {
    const handler = (_event, state) => cb(state);
    ipcRenderer.on('desktop:state', handler);
    return () => ipcRenderer.removeListener('desktop:state', handler);
  },
});
