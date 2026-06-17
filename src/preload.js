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
  isDefaultBrowser: () => ipcRenderer.invoke('rave:is-default-browser'),
  setDefaultBrowser: () => ipcRenderer.invoke('rave:set-default-browser'),
  newIncognito: () => ipcRenderer.send('rave:new-incognito'),
  copyText: (t) => clipboard.writeText(t),
  listExtensions: () => ipcRenderer.invoke('rave:list-extensions'),
  uninstallExtension: (id) => ipcRenderer.invoke('rave:uninstall-extension', id),
  openExtensionsFolder: () => ipcRenderer.send('rave:open-extensions-folder'),

  // Info de seguridad del sitio
  getSiteInfo: () => ipcRenderer.invoke('rave:get-site-info'),

  // Escudos por sitio
  getShields: (origin) => ipcRenderer.invoke('rave:get-shields', origin),
  setShields: (origin, key, value) => ipcRenderer.invoke('rave:set-shields', { origin, key, value }),
  resetShields: (origin) => ipcRenderer.invoke('rave:reset-shields', origin),
  getShieldsAll: () => ipcRenderer.invoke('rave:get-shields-all'),
  onShieldsStats: (cb) => on('rave:shields-stats', cb),

  // Cookies
  getCookies: (url) => ipcRenderer.invoke('rave:get-cookies', url),
  deleteCookie: (url, name) => ipcRenderer.invoke('rave:delete-cookie', { url, name }),
  clearSiteCookies: (url) => ipcRenderer.invoke('rave:clear-site-cookies', url),

  // Captura de pantalla
  capturePage: () => ipcRenderer.invoke('rave:capture-page'),

  // Modo lector
  injectReader: () => ipcRenderer.invoke('rave:inject-reader'),

  // Traducción inline
  translate: (text, tl) => ipcRenderer.invoke('rave:translate', { text, tl }),
  translatePage: (tl) => ipcRenderer.invoke('rave:translate-page', { tl }),
  restorePage: () => ipcRenderer.invoke('rave:restore-page'),

  // Descargas
  onDownloadStarted: (cb) => on('rave:download-started', cb),
  onDownloadProgress: (cb) => on('rave:download-progress', cb),
  onDownloadDone: (cb) => on('rave:download-done', cb),
  downloadOpen: (info) => ipcRenderer.invoke('rave:download-open', info),
  downloadSave: (info) => ipcRenderer.invoke('rave:download-save', info),
  downloadDelete: (info) => ipcRenderer.invoke('rave:download-delete', info),
  downloadShow: (info) => ipcRenderer.invoke('rave:download-show', info),
  downloadPause: (id) => ipcRenderer.send('rave:download-pause', { id }),
  downloadResume: (id) => ipcRenderer.send('rave:download-resume', { id }),
  downloadCancel: (id) => ipcRenderer.send('rave:download-cancel', { id }),
  downloadUrl: (url) => ipcRenderer.send('rave:download-url', url),

  // Privacidad
  setPrivacy: (p) => ipcRenderer.send('rave:set-privacy', p),
  setSleep: (minutes) => ipcRenderer.send('rave:set-sleep', minutes),

  // Permisos por sitio
  onPermissionRequest: (cb) => on('rave:permission-request', cb),
  permissionResponse: (r) => ipcRenderer.send('rave:permission-response', r),
  getSitePerms: (origin) => ipcRenderer.invoke('rave:get-site-perms', origin),
  getAllPerms: () => ipcRenderer.invoke('rave:get-all-perms'),
  setSitePerm: (origin, permission, value) => ipcRenderer.invoke('rave:set-site-perm', { origin, permission, value }),
  deleteSitePerms: (origin) => ipcRenderer.invoke('rave:delete-site-perms', origin),

  // Imprimir / PDF
  print: () => ipcRenderer.send('rave:print'),
  printPDF: () => ipcRenderer.invoke('rave:print-pdf'),

  // Cifrado de contraseñas
  encrypt: (text) => ipcRenderer.invoke('rave:encrypt', text),
  decrypt: (data) => ipcRenderer.invoke('rave:decrypt', data),

  // Importar marcadores de otros navegadores
  importBookmarks: () => ipcRenderer.invoke('rave:import-bookmarks'),

  // Actualizaciones OTA
  onUpdate: (cb) => on('rave:update', cb),
  updateCheck: () => ipcRenderer.send('rave:update-check'),
  updateInstall: () => ipcRenderer.send('rave:update-install'),

  pip: () => ipcRenderer.send('rave:pip'),

  // Controles de ventana
  winMinimize: () => ipcRenderer.send('rave:win-minimize'),
  winMaximize: () => ipcRenderer.send('rave:win-maximize'),
  winClose: () => ipcRenderer.send('rave:win-close'),
  winIsMaximized: () => ipcRenderer.invoke('rave:win-is-maximized'),
  onWinState: (cb) => on('rave:win-state', cb),

  tabSplitToggle: (id, newTabUrl, splitRatio, activeSide) => ipcRenderer.send('rave:tab-split-toggle', { id, newTabUrl, splitRatio, activeSide }),
  tabSplitMerge: (targetId, sourceId, side) => ipcRenderer.send('rave:tab-split-merge', { targetId, sourceId, side }),
  onTabSplitState: (cb) => on('rave:tab-split-state', cb),
  onTabSplitFocus: (cb) => on('rave:tab-split-focus', cb),
  onSaveSession: (cb) => on('rave:save-session', cb),
  onTabSplitRatioUpdated: (cb) => on('rave:tab-split-ratio-updated', cb),
  dividerDragStart: (screenX) => ipcRenderer.send('rave:divider-drag-start', screenX),
  dividerDragMove: (screenX) => ipcRenderer.send('rave:divider-drag-move', screenX),
  dividerDragEnd: () => ipcRenderer.send('rave:divider-drag-end'),


  // Fijar pestana
  tabPin: (id) => ipcRenderer.send('rave:tab-pin', { id }),

  // Motores de busqueda personalizados
  getEngines: () => ipcRenderer.invoke('rave:get-engines'),
  setDefaultEngine: (id) => ipcRenderer.invoke('rave:set-default-engine', id),
  addEngine: (e) => ipcRenderer.invoke('rave:add-engine', e),
  deleteEngine: (id) => ipcRenderer.invoke('rave:delete-engine', id),
  historySearch: (q) => ipcRenderer.invoke('rave:history-search', q),
  historyClear: () => ipcRenderer.invoke('rave:history-clear'),
  historyDelete: (entry) => ipcRenderer.invoke('rave:history-delete', entry),

  // Vista previa de pestaña
  tabPreview: (id) => ipcRenderer.invoke('rave:tab-preview', id),

  // Controles de medios
  onMediaState: (cb) => on('rave:media-state', cb),
  mediaControl: (action) => ipcRenderer.send('rave:media-control', action),
  mediaInfo: () => ipcRenderer.invoke('rave:media-info'),

  // Visor de PDF integrado
  onOpenPDF: (cb) => on('rave:open-pdf', cb),

  // QR de la URL actual
  qrGenerate: (url) => ipcRenderer.invoke('rave:qr-generate', url),

  // Verificar contraseña comprometida (HIBP)
  checkPwned: (password) => ipcRenderer.invoke('rave:check-pwned', password),
});
