const { contextBridge, ipcRenderer, clipboard } = require('electron');

// Habilita el elemento <browser-action-list> (iconos y popups de extensiones).
try { require('electron-chrome-extensions/browser-action').injectBrowserAction(); } catch (e) { /* sin extensiones */ }

const on = (ch, cb) => ipcRenderer.on(ch, (_e, d) => cb(d));

contextBridge.exposeInMainWorld('rave', {
  // Pestañas (la página vive en el proceso principal como WebContentsView)
  tabCreate: (url) => ipcRenderer.invoke('rave:tab-create', url),
  tabSelect: (id) => ipcRenderer.send('rave:tab-select', id),
  tabClose: (id) => ipcRenderer.send('rave:tab-close', id),
  tabAction: (id, action, arg) => ipcRenderer.send('rave:tab-action', { id, action, arg }),

  // Eventos de pestaña que envía el proceso principal
  onTabOpened: (cb) => on('rave:tab-opened', cb),
  onTabActivated: (cb) => on('rave:tab-activated', cb),
  onTabClosed: (cb) => on('rave:tab-closed', cb),
  onTabUpdated: (cb) => on('rave:tab-updated', cb),
  onTabFound: (cb) => on('rave:tab-found', cb),
  onContextMenu: (cb) => on('rave:context-menu', cb),
  onPasswordFormDetected: (cb) => on('rave:password-form-detected', cb),

  // Disposición (la interfaz le dice al main dónde empieza la página)
  setLayout: (chromeH) => ipcRenderer.send('rave:set-layout', { chromeH }),
  setOverlay: (on) => ipcRenderer.send('rave:set-overlay', on),
  onViewSize: (cb) => on('rave:view-size', cb),

  // Varios
  getBlockedCount: () => ipcRenderer.invoke('rave:get-blocked-count'),
  newIncognito: () => ipcRenderer.send('rave:new-incognito'),
  copyText: (t) => clipboard.writeText(t),
  listExtensions: () => ipcRenderer.invoke('rave:list-extensions'),
  uninstallExtension: (id) => ipcRenderer.invoke('rave:uninstall-extension', id),
  openExtensionsFolder: () => ipcRenderer.send('rave:open-extensions-folder'),

  // Cookies
  getCookies: (url) => ipcRenderer.invoke('rave:get-cookies', url),
  deleteCookie: (url, name) => ipcRenderer.invoke('rave:delete-cookie', { url, name }),
  clearSiteCookies: (url) => ipcRenderer.invoke('rave:clear-site-cookies', url),

  // Captura de pantalla
  capturePage: () => ipcRenderer.invoke('rave:capture-page'),

  // Modo lector
  injectReader: () => ipcRenderer.invoke('rave:inject-reader'),

  // Descargas
  onDownloadStarted: (cb) => on('rave:download-started', cb),
  onDownloadDone: (cb) => on('rave:download-done', cb),

  // Actualizaciones OTA
  onUpdate: (cb) => on('rave:update', cb),
  updateCheck: () => ipcRenderer.send('rave:update-check'),
  updateInstall: () => ipcRenderer.send('rave:update-install'),

  // Controles de ventana
  winMinimize: () => ipcRenderer.send('rave:win-minimize'),
  winMaximize: () => ipcRenderer.send('rave:win-maximize'),
  winClose: () => ipcRenderer.send('rave:win-close'),
  winIsMaximized: () => ipcRenderer.invoke('rave:win-is-maximized'),
  onWinState: (cb) => on('rave:win-state', cb),

  // Pantalla dividida
  tabSplitToggle: (id, newTabUrl) => ipcRenderer.send('rave:tab-split-toggle', { id, newTabUrl }),
  tabSplitMerge: (targetId, sourceId, side) => ipcRenderer.send('rave:tab-split-merge', { targetId, sourceId, side }),
  onTabSplitState: (cb) => on('rave:tab-split-state', cb),
  onTabSplitFocus: (cb) => on('rave:tab-split-focus', cb),
});
