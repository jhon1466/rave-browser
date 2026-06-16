const { app, BaseWindow, WebContentsView, Menu, session, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { setupAdblock, enableBlockingOn } = require('./adblock');
const { installChromeWebStore } = require('electron-chrome-web-store');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { setupUpdater, checkNow, quitAndInstall } = require('./updater');

// Envía un mensaje a la interfaz de todas las ventanas abiertas.
const broadcast = (ch, data) => { for (const s of states.values()) s.ui.webContents.send(ch, data); };

let extensions = null;   // instancia de ElectronChromeExtensions (APIs chrome.* + popups)
const NEWTAB_FALLBACK = 'https://duckduckgo.com/';
const focusedState = () => {
  const fw = BaseWindow.getFocusedWindow();
  for (const s of states.values()) if (s.win === fw) return s;
  return [...states.values()][0];
};

const EXT_DIR = () => path.join(app.getPath('userData'), 'Extensions');

// ====== Estado por ventana ======
// Cada ventana tiene: la vista de interfaz (chrome) + un mapa de pestañas
// (id -> WebContentsView). El proceso principal es la fuente de la verdad.
const states = new Map();           // uiWebContentsId -> state
let tabSeq = 1;

const UI_FILE = path.join(__dirname, 'renderer', 'index.html');

// Script anti-anuncios de YouTube (respaldo, por si el scriptlet de uBO falla).
const YT_ADSKIP = `(function(){if(window.__raveYT)return;window.__raveYT=true;function t(){try{var v=document.querySelector('video'),p=document.querySelector('.html5-video-player');var s=document.querySelector('.ytp-ad-skip-button,.ytp-ad-skip-button-modern,.ytp-skip-ad-button');if(s)s.click();if(p&&p.classList.contains('ad-showing')&&v){if(!isNaN(v.duration)&&isFinite(v.duration))v.currentTime=v.duration;v.muted=true;v.playbackRate=16;}var o=document.querySelector('.ytp-ad-overlay-close-button,.ytp-ad-overlay-close-container');if(o)o.click();document.querySelectorAll('#player-ads,.ytp-ad-overlay-slot,ytd-display-ad-renderer,ytd-promoted-video-renderer,ytd-ad-slot-renderer,ytd-in-feed-ad-layout-renderer,#masthead-ad').forEach(function(e){e.remove();});}catch(e){}}setInterval(t,250);t();})();`;

// ====== Creación de ventanas ======
function createWindow(incognito = false) {
  let partition = null, tabSession = session.defaultSession;
  if (incognito) {
    partition = 'incognito-' + Date.now();
    tabSession = session.fromPartition(partition);   // en memoria (sin persist:)
    enableBlockingOn(tabSession);
    attachDownloads(tabSession);
  }

  const win = new BaseWindow({
    width: 1280, height: 800, minWidth: 720, minHeight: 420,
    frame: false, backgroundColor: incognito ? '#0d0d0f' : '#ffffff', title: 'Rave'
  });

  // Vista de interfaz (chrome). Va arriba en el z-order.
  const ui = new WebContentsView({
    // sandbox:false para poder inyectar el elemento <browser-action-list> desde el preload.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  ui.setBackgroundColor('#00000000');   // transparente: la página se ve bajo los overlays
  win.contentView.addChildView(ui);
  ui.webContents.loadFile(UI_FILE, {
    search: incognito ? `incognito=1&partition=${encodeURIComponent(partition)}` : ''
  });

  const state = { win, ui, tabs: new Map(), activeId: null, chromeH: 96, overlay: false, incognito, partition, tabSession };
  states.set(ui.webContents.id, state);

  const layout = () => relayout(state);
  win.on('resize', layout);
  win.on('maximize', () => { ui.webContents.send('rave:win-state', true); layout(); });
  win.on('unmaximize', () => { ui.webContents.send('rave:win-state', false); layout(); });
  win.on('closed', () => states.delete(ui.webContents.id));

  layout();
  return state;
}

// Recalcula la posición de la vista de interfaz y de la pestaña activa.
function relayout(state) {
  const [w, h] = state.win.getContentSize();
  const top = state.overlay ? h : state.chromeH;       // overlay: el chrome cubre todo
  state.ui.setBounds({ x: 0, y: 0, width: w, height: Math.round(top) });
  const tab = state.tabs.get(state.activeId);
  if (tab) tab.view.setBounds({ x: 0, y: Math.round(state.chromeH), width: w, height: Math.round(h - state.chromeH) });
  // La interfaz necesita el alto real de la ventana para posicionar overlays
  // (p. ej. el menú contextual), porque su propia vista mide solo el chrome.
  state.ui.webContents.send('rave:view-size', { w, h });
}

// ====== Pestañas ======
function openTab(state, url) {
  const id = tabSeq++;
  const view = new WebContentsView({
    webPreferences: state.incognito ? { partition: state.partition } : {}
  });
  view.setBackgroundColor(state.incognito ? '#0d0d0f' : '#ffffff');
  state.win.contentView.addChildView(view, 0);          // por debajo de la interfaz
  view.setVisible(false);
  state.tabs.set(id, { id, view });

  const wc = view.webContents;
  const send = (fields) => state.ui.webContents.send('rave:tab-updated', { id, ...fields });
  const navState = () => ({
    canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
    canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward()
  });

  wc.on('did-start-loading', () => send({ loading: true }));
  wc.on('did-stop-loading', () => send({ loading: false, ...navState() }));
  wc.on('page-title-updated', (_e, title) => send({ title }));
  wc.on('page-favicon-updated', (_e, favicons) => send({ favicon: favicons && favicons[0] }));
  const onNav = () => { send({ url: wc.getURL(), ...navState() }); maybeYouTube(wc); };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  wc.on('dom-ready', () => maybeYouTube(wc));
  wc.on('found-in-page', (_e, r) => state.ui.webContents.send('rave:tab-found', { id, ...r }));
  wc.on('context-menu', (_e, p) => state.ui.webContents.send('rave:context-menu', { id, p }));
  wc.setWindowOpenHandler(({ url: u }) => { openTab(state, u); return { action: 'deny' }; });

  // Da de alta la pestaña en el sistema de extensiones (chrome.tabs + acciones).
  if (extensions && !state.incognito) extensions.addTab(wc, state.win);

  wc.loadURL(url);
  state.ui.webContents.send('rave:tab-opened', { id, url });
  selectTab(state, id);
  return state.tabs.get(id);
}

function selectTab(state, id) {
  if (!state.tabs.has(id)) return;
  state.activeId = id;
  for (const [tid, t] of state.tabs) t.view.setVisible(tid === id);
  relayout(state);
  if (extensions && !state.incognito) extensions.selectTab(state.tabs.get(id).view.webContents);
  state.ui.webContents.send('rave:tab-activated', { id });
}

function closeTab(state, id) {
  const t = state.tabs.get(id);
  if (!t) return;
  state.win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  state.tabs.delete(id);
  state.ui.webContents.send('rave:tab-closed', { id });
}

function maybeYouTube(wc) {
  if (/(^|\.)youtube\.com|youtube-nocookie\.com/.test(wc.getURL()))
    wc.executeJavaScript(YT_ADSKIP, true).catch(() => {});
}

// ====== Extensiones de Chrome ======
// Habilita la Chrome Web Store (instalar/actualizar) y carga las ya instaladas.
async function setupExtensions(ses) {
  fs.mkdirSync(EXT_DIR(), { recursive: true });
  try {
    await installChromeWebStore({
      session: ses,
      extensionsPath: EXT_DIR(),
      loadExtensions: true,
      allowUnpackedExtensions: true,   // permite también carpetas descomprimidas
      autoUpdate: true
    });
    console.log('[Rave] Chrome Web Store habilitada. Extensiones en:', EXT_DIR());
  } catch (e) {
    console.error('[Rave] No se pudo habilitar la Chrome Web Store:', e.message);
  }
}
function listExtensions(ses) {
  const ext = ses.extensions || ses;
  try { return ext.getAllExtensions().map((e) => ({ name: e.name, version: e.version, id: e.id })); }
  catch { return []; }
}

// ====== Descargas ======
function attachDownloads(ses) {
  if (ses.__raveDownloads) return;
  ses.__raveDownloads = true;
  ses.on('will-download', (_e, item) => {
    const info = { name: item.getFilename(), total: item.getTotalBytes() };
    const bcast = (ch, extra) => { for (const s of states.values()) s.ui.webContents.send(ch, { ...info, ...extra }); };
    bcast('rave:download-started');
    item.once('done', (_ev, st) => bcast('rave:download-done', { state: st }));
  });
}

// ====== Arranque ======
Menu.setApplicationMenu(null);
process.on('unhandledRejection', (err) => {
  const m = (err && err.message) || String(err);
  if (m.includes('Script failed to execute') || m.includes('disposed')) return;
  console.error('[Rave] unhandledRejection:', m);
});

app.whenReady().then(async () => {
  await setupAdblock(session.defaultSession);
  attachDownloads(session.defaultSession);

  // Sistema de extensiones: APIs chrome.*, acciones de barra y popups.
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession);   // iconos crx://
  extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: session.defaultSession,
    createTab: async (details) => {
      const s = focusedState();
      const t = openTab(s, details.url || NEWTAB_FALLBACK);
      return [t.view.webContents, s.win];
    },
    selectTab: (tab) => {
      for (const s of states.values())
        for (const [id, t] of s.tabs)
          if (t.view.webContents === tab) return selectTab(s, id);
    },
    removeTab: (tab) => {
      for (const s of states.values())
        for (const [id, t] of s.tabs)
          if (t.view.webContents === tab) return closeTab(s, id);
    },
    createWindow: () => createWindow(false).win
  });

  await setupExtensions(session.defaultSession);
  createWindow();
  setupUpdater(broadcast);   // comprueba actualizaciones OTA (solo app empaquetada)
  app.on('activate', () => { if (states.size === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ====== IPC ======
const st = (e) => states.get(e.sender.id);

ipcMain.handle('rave:get-blocked-count', () => global.__raveBlockedCount || 0);
ipcMain.on('rave:new-incognito', () => createWindow(true));
ipcMain.handle('rave:list-extensions', (e) => listExtensions(st(e)?.tabSession || session.defaultSession));
ipcMain.on('rave:open-extensions-folder', () => shell.openPath(EXT_DIR()));
ipcMain.on('rave:update-check', () => checkNow());
ipcMain.on('rave:update-install', () => quitAndInstall());

// Pestañas
ipcMain.handle('rave:tab-create', (e, url) => { const s = st(e); return s ? openTab(s, url).id : null; });
ipcMain.on('rave:tab-select', (e, id) => { const s = st(e); if (s) selectTab(s, id); });
ipcMain.on('rave:tab-close', (e, id) => { const s = st(e); if (s) closeTab(s, id); });
ipcMain.on('rave:tab-action', (e, { id, action, arg }) => {
  const s = st(e); const t = s && s.tabs.get(id); if (!t) return;
  const wc = t.view.webContents; const nh = wc.navigationHistory;
  switch (action) {
    case 'navigate': wc.loadURL(arg); break;
    case 'back': nh ? nh.goBack() : wc.goBack(); break;
    case 'forward': nh ? nh.goForward() : wc.goForward(); break;
    case 'reload': wc.reload(); break;
    case 'stop': wc.stop(); break;
    case 'zoom': wc.setZoomFactor(arg); break;
    case 'find': wc.findInPage(arg.text, arg.opts); break;
    case 'stopFind': wc.stopFindInPage('clearSelection'); break;
    case 'inspect': wc.inspectElement(arg.x, arg.y); break;
    case 'copy': wc.copy(); break;
    case 'cut': wc.cut(); break;
    case 'paste': wc.paste(); break;
  }
});

// Disposición
ipcMain.on('rave:set-layout', (e, { chromeH }) => { const s = st(e); if (s) { s.chromeH = chromeH; relayout(s); } });
ipcMain.on('rave:set-overlay', (e, on) => { const s = st(e); if (s) { s.overlay = on; relayout(s); } });

// Portapapeles (texto) lo maneja el preload con clipboard.

// Controles de ventana
ipcMain.on('rave:win-minimize', (e) => st(e)?.win.minimize());
ipcMain.on('rave:win-maximize', (e) => { const w = st(e)?.win; if (!w) return; w.isMaximized() ? w.unmaximize() : w.maximize(); });
ipcMain.on('rave:win-close', (e) => st(e)?.win.close());
ipcMain.handle('rave:win-is-maximized', (e) => st(e)?.win.isMaximized() ?? false);
