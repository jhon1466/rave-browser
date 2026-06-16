const { app, BaseWindow, WebContentsView, Menu, session, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { setupAdblock, enableBlockingOn } = require('./adblock');
const { installChromeWebStore, uninstallExtension } = require('electron-chrome-web-store');
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
  if (tab) {
    const y = Math.round(state.chromeH);
    const height = Math.round(h - state.chromeH);
    if (tab.splitView) {
      const halfW = Math.round(w / 2);
      tab.view.setBounds({ x: 0, y, width: halfW, height });
      tab.splitView.setBounds({ x: halfW, y, width: w - halfW, height });
    } else {
      tab.view.setBounds({ x: 0, y, width: w, height });
    }
  }
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
  state.tabs.set(id, { id, view, splitView: null, splitUrl: null, activeFocus: 'primary' });

  const wc = view.webContents;
  const send = (fields) => state.ui.webContents.send('rave:tab-updated', { id, ...fields });
  const navState = () => ({
    canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
    canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward()
  });

  wc.on('did-start-loading', () => {
    const t = state.tabs.get(id);
    if (!t || t.activeFocus === 'primary') send({ loading: true });
  });
  wc.on('did-stop-loading', () => {
    const t = state.tabs.get(id);
    if (!t || t.activeFocus === 'primary') send({ loading: false, ...navState() });
  });
  wc.on('page-title-updated', (_e, title) => {
    const t = state.tabs.get(id);
    if (!t || t.activeFocus === 'primary') send({ title });
  });
  wc.on('page-favicon-updated', (_e, favicons) => {
    const t = state.tabs.get(id);
    if (!t || t.activeFocus === 'primary') send({ favicon: favicons && favicons[0] });
  });
  const onNav = () => {
    const t = state.tabs.get(id);
    if (t) t.url = wc.getURL();
    if (!t || t.activeFocus === 'primary') {
      send({ url: wc.getURL(), ...navState() });
    }
    maybeYouTube(wc);
  };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  wc.on('dom-ready', () => { maybeYouTube(wc); detectPasswordForms(wc, state, id); });
  wc.on('found-in-page', (_e, r) => {
    const t = state.tabs.get(id);
    if (!t || t.activeFocus === 'primary') state.ui.webContents.send('rave:tab-found', { id, ...r });
  });
  wc.on('context-menu', (_e, p) => {
    const t = state.tabs.get(id);
    if (!t || t.activeFocus === 'primary') state.ui.webContents.send('rave:context-menu', { id, p });
  });
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
  for (const [tid, t] of state.tabs) {
    const isAct = (tid === id);
    t.view.setVisible(isAct);
    if (t.splitView) t.splitView.setVisible(isAct);
  }
  relayout(state);
  if (extensions && !state.incognito) extensions.selectTab(state.tabs.get(id).view.webContents);
  state.ui.webContents.send('rave:tab-activated', { id });
  
  // Sincronizar estado de pantalla dividida a la UI
  const t = state.tabs.get(id);
  state.ui.webContents.send('rave:tab-split-state', {
    id,
    isSplit: !!t.splitView,
    activeSide: t.activeFocus || 'primary'
  });
}

function closeTab(state, id) {
  const t = state.tabs.get(id);
  if (!t) return;
  state.win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  if (t.splitView) {
    state.win.contentView.removeChildView(t.splitView);
    t.splitView.webContents.close();
  }
  state.tabs.delete(id);
  state.ui.webContents.send('rave:tab-closed', { id });
}

function notifyTabUpdated(state, tabId, wc) {
  const navState = {
    canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
    canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward()
  };
  state.ui.webContents.send('rave:tab-updated', {
    id: tabId,
    url: wc.getURL(),
    title: wc.getTitle() || 'Nueva pestaña',
    loading: wc.isLoading(),
    ...navState
  });
}

function setupPaneListeners(state, tabId, side) {
  const t = state.tabs.get(tabId);
  if (!t) return;
  const view = (side === 'primary') ? t.view : t.splitView;
  if (!view) return;
  const wc = view.webContents;

  // Limpiar anteriores
  wc.removeAllListeners('did-start-loading');
  wc.removeAllListeners('did-stop-loading');
  wc.removeAllListeners('page-title-updated');
  wc.removeAllListeners('page-favicon-updated');
  wc.removeAllListeners('did-navigate');
  wc.removeAllListeners('did-navigate-in-page');
  wc.removeAllListeners('dom-ready');
  wc.removeAllListeners('found-in-page');
  wc.removeAllListeners('context-menu');
  wc.removeAllListeners('focus');

  // Registrar nuevos
  const send = (fields) => state.ui.webContents.send('rave:tab-updated', { id: tabId, ...fields });
  const navState = () => ({
    canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
    canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward()
  });

  wc.on('did-start-loading', () => {
    const tab = state.tabs.get(tabId);
    if (tab && tab.activeFocus === side) send({ loading: true });
  });
  wc.on('did-stop-loading', () => {
    const tab = state.tabs.get(tabId);
    if (tab && tab.activeFocus === side) send({ loading: false, ...navState() });
  });
  wc.on('page-title-updated', (_e, title) => {
    const tab = state.tabs.get(tabId);
    if (tab && tab.activeFocus === side) send({ title });
  });
  wc.on('page-favicon-updated', (_e, favicons) => {
    const tab = state.tabs.get(tabId);
    if (tab && tab.activeFocus === side) send({ favicon: favicons && favicons[0] });
  });
  
  const onNav = () => {
    if (side === 'primary') {
      t.url = wc.getURL();
    } else {
      t.splitUrl = wc.getURL();
    }
    const tab = state.tabs.get(tabId);
    if (tab && tab.activeFocus === side) {
      send({ url: wc.getURL(), ...navState() });
    }
    maybeYouTube(wc);
  };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  wc.on('dom-ready', () => { maybeYouTube(wc); detectPasswordForms(wc, state, tabId); });
  wc.on('found-in-page', (_e, r) => {
    const tab = state.tabs.get(tabId);
    if (tab && tab.activeFocus === side) state.ui.webContents.send('rave:tab-found', { id: tabId, ...r });
  });
  wc.on('context-menu', (_e, p) => {
    const tab = state.tabs.get(tabId);
    if (tab && tab.activeFocus === side) state.ui.webContents.send('rave:context-menu', { id: tabId, p });
  });
  wc.setWindowOpenHandler(({ url: u }) => { openTab(state, u); return { action: 'deny' }; });

  wc.on('focus', () => {
    const tab = state.tabs.get(tabId);
    if (tab && tab.splitView && tab.activeFocus !== side) {
      tab.activeFocus = side;
      state.ui.webContents.send('rave:tab-split-focus', { id: tabId, side });
      notifyTabUpdated(state, tabId, wc);
    }
  });
}

function mergeTabs(state, targetId, sourceId, side) {
  const tA = state.tabs.get(targetId);
  const tB = state.tabs.get(sourceId);
  if (!tA || !tB || targetId === sourceId) return;

  // Si tA ya tiene pantalla dividida, no podemos meter otra.
  if (tA.splitView) return;

  // Quitar la vista de B de la ventana
  state.win.contentView.removeChildView(tB.view);

  if (side === 'left') {
    tA.splitView = tA.view;
    tA.view = tB.view;
    tA.activeFocus = 'primary';
  } else {
    tA.splitView = tB.view;
    tA.activeFocus = 'secondary';
  }

  // Asegurar que ambas vistas están agregadas a la ventana
  state.win.contentView.addChildView(tA.view, 0);
  state.win.contentView.addChildView(tA.splitView, 0);

  // Configurar escuchadores para ambas partes
  setupPaneListeners(state, targetId, 'primary');
  setupPaneListeners(state, targetId, 'secondary');

  // Eliminar la pestaña B del mapa y notificar al renderer
  state.tabs.delete(sourceId);
  state.ui.webContents.send('rave:tab-closed', { id: sourceId });

  // Hacer visible y relayout
  tA.view.setVisible(true);
  tA.splitView.setVisible(true);
  relayout(state);

  // Sincronizar estado con la interfaz
  state.ui.webContents.send('rave:tab-split-state', {
    id: targetId,
    isSplit: true,
    activeSide: tA.activeFocus
  });

  // Actualizar la interfaz con los datos del panel activo
  const activeWc = (tA.activeFocus === 'primary') ? tA.view.webContents : tA.splitView.webContents;
  notifyTabUpdated(state, targetId, activeWc);
}

function toggleSplitTab(state, tabId) {
  const t = state.tabs.get(tabId);
  if (!t) return;

  if (t.splitView) {
    // Cerrar pantalla dividida
    state.win.contentView.removeChildView(t.splitView);
    t.splitView.webContents.close();
    t.splitView = null;
    t.splitUrl = null;
    t.activeFocus = 'primary';
    relayout(state);
    
    state.ui.webContents.send('rave:tab-split-state', {
      id: tabId,
      isSplit: false
    });
    
    notifyTabUpdated(state, tabId, t.view.webContents);
  } else {
    // Abrir pantalla dividida
    const splitView = new WebContentsView({
      webPreferences: state.incognito ? { partition: state.partition } : {}
    });
    splitView.setBackgroundColor(state.incognito ? '#0d0d0f' : '#ffffff');
    state.win.contentView.addChildView(splitView, 0);
    
    t.splitView = splitView;
    t.activeFocus = 'secondary';

    // Cargar la página nueva pestaña por defecto en la división
    const newTabPath = path.join(__dirname, 'renderer', 'newtab.html');
    splitView.webContents.loadFile(newTabPath);

    // Configurar los escuchadores para ambas partes usando la función helper
    setupPaneListeners(state, tabId, 'primary');
    setupPaneListeners(state, tabId, 'secondary');

    splitView.setVisible(true);
    relayout(state);

    state.ui.webContents.send('rave:tab-split-state', {
      id: tabId,
      isSplit: true,
      activeSide: 'secondary'
    });
  }
}

function maybeYouTube(wc) {
  if (/(^|\.)youtube\.com|youtube-nocookie\.com/.test(wc.getURL()))
    wc.executeJavaScript(YT_ADSKIP, true).catch(() => {});
}

// Detecta formularios con <input type="password"> y notifica la UI.
async function detectPasswordForms(wc, state, tabId) {
  try {
    const found = await wc.executeJavaScript(
      '!!(document.querySelector(\'input[type="password"]\')); true',
      true
    );
    if (found) {
      state.ui.webContents.send('rave:password-form-detected', { tabId, url: wc.getURL() });
    }
  } catch { /* ignorar si la página está cerrada */ }
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
ipcMain.handle('rave:uninstall-extension', async (e, id) => {
  const ses = st(e)?.tabSession || session.defaultSession;
  try {
    await uninstallExtension(id, { session: ses, extensionsPath: EXT_DIR() });
    return true;
  } catch (err) {
    console.error('[Rave] Error al desinstalar extensión:', err);
    return false;
  }
});
ipcMain.on('rave:open-extensions-folder', () => shell.openPath(EXT_DIR()));
ipcMain.on('rave:update-check', () => checkNow());
ipcMain.on('rave:update-install', () => quitAndInstall());

// Cookies
ipcMain.handle('rave:get-cookies', async (e, url) => {
  const s = st(e);
  const ses = s?.tabSession || session.defaultSession;
  try { return await ses.cookies.get(url ? { url } : {}); } catch { return []; }
});
ipcMain.handle('rave:delete-cookie', async (e, { url, name }) => {
  const s = st(e);
  const ses = s?.tabSession || session.defaultSession;
  try { await ses.cookies.remove(url, name); return true; } catch { return false; }
});
ipcMain.handle('rave:clear-site-cookies', async (e, url) => {
  const s = st(e);
  const ses = s?.tabSession || session.defaultSession;
  try {
    const cookies = await ses.cookies.get({ url });
    for (const c of cookies) await ses.cookies.remove(url, c.name);
    return true;
  } catch { return false; }
});

// Captura de pantalla
ipcMain.handle('rave:capture-page', async (e) => {
  const s = st(e);
  if (!s || !s.activeId) return null;
  const tab = s.tabs.get(s.activeId);
  if (!tab) return null;
  try {
    const targetView = (tab.splitView && tab.activeFocus === 'secondary') ? tab.splitView : tab.view;
    const image = await targetView.webContents.capturePage();
    return image.toDataURL();
  } catch { return null; }
});

// Modo lector — inyecta CSS + JS para simplificar la página
const READER_CSS = `
  body { max-width: 720px !important; margin: 40px auto !important; font-family: Georgia, serif !important;
         font-size: 18px !important; line-height: 1.7 !important; color: #1a1a1a !important;
         background: #f9f6f0 !important; padding: 0 24px !important; }
  *:not(body):not(article):not(p):not(h1):not(h2):not(h3):not(h4):not(h5):not(h6):not(img):not(blockquote):not(pre):not(code):not(ul):not(ol):not(li):not(a):not(strong):not(em) {
         opacity: 0 !important; pointer-events: none !important; height: 0 !important;
         overflow: hidden !important; position: absolute !important; }
  article, [role="main"], main, .article, .post, #article, #content, .content, [itemprop="articleBody"]
  { display: block !important; opacity: 1 !important; pointer-events: auto !important;
    height: auto !important; overflow: visible !important; position: static !important;
    max-width: 100% !important; }
  img { max-width: 100% !important; height: auto !important; opacity: 1 !important;
        pointer-events: auto !important; position: static !important; }
  p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,code,strong,em,a {
    opacity: 1 !important; pointer-events: auto !important;
    height: auto !important; overflow: visible !important; position: static !important; }
`;
ipcMain.handle('rave:inject-reader', async (e) => {
  const s = st(e);
  if (!s || !s.activeId) return false;
  const tab = s.tabs.get(s.activeId);
  if (!tab) return false;
  try {
    const targetView = (tab.splitView && tab.activeFocus === 'secondary') ? tab.splitView : tab.view;
    await targetView.webContents.insertCSS(READER_CSS);
    return true;
  } catch { return false; }
});

// Pestañas
ipcMain.handle('rave:tab-create', (e, url) => { const s = st(e); return s ? openTab(s, url).id : null; });
ipcMain.on('rave:tab-select', (e, id) => { const s = st(e); if (s) selectTab(s, id); });
ipcMain.on('rave:tab-close', (e, id) => { const s = st(e); if (s) closeTab(s, id); });
ipcMain.on('rave:tab-split-toggle', (e, id) => { const s = st(e); if (s) toggleSplitTab(s, id); });
ipcMain.on('rave:tab-split-merge', (e, { targetId, sourceId, side }) => { const s = st(e); if (s) mergeTabs(s, targetId, sourceId, side); });
ipcMain.on('rave:tab-action', (e, { id, action, arg }) => {
  const s = st(e); const t = s && s.tabs.get(id); if (!t) return;
  const targetView = (t.splitView && t.activeFocus === 'secondary') ? t.splitView : t.view;
  const wc = targetView.webContents; const nh = wc.navigationHistory;
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
