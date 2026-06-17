const { app, BaseWindow, WebContentsView, Menu, session, ipcMain, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

// ====== Estado de la ventana (tamaño/posición/maximizada) ======
const WIN_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');
function loadWinState() {
  try { return JSON.parse(fs.readFileSync(WIN_STATE_FILE(), 'utf8')); } catch { return null; }
}
let _winStateT = null;
function saveWinState(win) {
  clearTimeout(_winStateT);
  _winStateT = setTimeout(() => {
    try {
      const maximized = win.isMaximized();
      const b = maximized ? (win.__normalBounds || win.getBounds()) : win.getBounds();
      fs.writeFileSync(WIN_STATE_FILE(), JSON.stringify({ ...b, maximized }));
    } catch {}
  }, 400);
}
const { setupAdblock, enableBlockingOn, disableBlockingOn } = require('./adblock');
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

// ====== Privacidad ======
// Estado actual de privacidad (lo fija la interfaz desde Ajustes).
let privacy = { level: 'standard', dnt: false, httpsOnly: false, clearOnExit: false };
const wantDNT = () => privacy.dnt || privacy.level === 'strict';
const wantHTTPS = () => privacy.httpsOnly || privacy.level === 'strict';
const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(u);

// Instala en una sesión los handlers de privacidad que NO chocan con el
// adblocker (este usa onBeforeRequest/onHeadersReceived; nosotros solo
// onBeforeSendHeaders para DNT/GPC). Se registra una sola vez y lee el
// estado en vivo, así alternar no requiere re-registrar.
function installPrivacy(ses) {
  if (ses.__ravePrivacy) return;
  ses.__ravePrivacy = true;
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    if (wantDNT()) { h['DNT'] = '1'; h['Sec-GPC'] = '1'; }
    else { delete h['DNT']; delete h['Sec-GPC']; }
    cb({ requestHeaders: h });
  });
}

// Recorre todas las sesiones de pestañas activas (normal + incógnitos).
function forEachTabSession(cb) {
  const seen = new Set();
  const add = (s) => { if (s && !seen.has(s)) { seen.add(s); cb(s); } };
  add(session.defaultSession);
  for (const s of states.values()) add(s.tabSession);
}

// Aplica el nivel de protección (activa/desactiva el bloqueador por sesión).
function applyTrackerLevel() {
  forEachTabSession((ses) => {
    if (privacy.level === 'off') disableBlockingOn(ses);
    else enableBlockingOn(ses);
  });
}

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
    if (privacy.level !== 'off') enableBlockingOn(tabSession);
    attachDownloads(tabSession);
    installPrivacy(tabSession);
    installPermissions(tabSession);
    installCerts(tabSession);
  }

  const ws = incognito ? null : loadWinState();
  const win = new BaseWindow({
    width: ws?.width || 1280, height: ws?.height || 800,
    x: ws?.x, y: ws?.y,
    minWidth: 720, minHeight: 420,
    frame: false, backgroundColor: incognito ? '#0d0d0f' : '#ffffff', title: 'Rave',
    icon: path.join(__dirname, '..', 'build', 'icon.png')
  });
  if (ws?.maximized) win.maximize();

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
  const persist = () => { if (!incognito) { if (!win.isMaximized()) win.__normalBounds = win.getBounds(); saveWinState(win); } };
  win.on('resize', () => { layout(); persist(); });
  win.on('move', persist);
  win.on('maximize', () => { ui.webContents.send('rave:win-state', true); layout(); persist(); });
  win.on('unmaximize', () => { ui.webContents.send('rave:win-state', false); layout(); persist(); });
  win.on('close', persist);
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
      const splitRatio = tab.splitRatio ?? 0.5;
      const gap = 6;
      const totalW = w - gap;
      const splitW = Math.round(totalW * splitRatio);
      tab.view.setBounds({ x: 0, y, width: splitW, height });
      if (tab.dividerView) {
        tab.dividerView.setBounds({ x: splitW, y, width: gap, height });
        tab.dividerView.setVisible(true);
      }
      tab.splitView.setBounds({ x: splitW + gap, y, width: w - (splitW + gap), height });
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
    webPreferences: state.incognito
      ? { partition: state.partition, spellcheck: true }
      : { spellcheck: true }
  });
  view.setBackgroundColor(state.incognito ? '#0d0d0f' : '#ffffff');
  state.win.contentView.addChildView(view, 0);          // por debajo de la interfaz
  view.setVisible(false);
  state.tabs.set(id, { id, view, splitView: null, splitUrl: null, activeFocus: 'primary', lastActiveAt: Date.now(), suspended: false, suspendedUrl: null });

  const wc = view.webContents;
  wc.setMaxListeners(30); // Prevenir MaxListenersExceededWarning al usar pantalla dividida
  // No propaga eventos a la interfaz mientras la pestaña está suspendida
  // (la carga de about:blank no debe borrar el título/URL mostrados).
  const send = (fields) => {
    const t = state.tabs.get(id);
    if (t && t.suspended) return;
    state.ui.webContents.send('rave:tab-updated', { id, ...fields });
  };
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
    if (t && t.suspended) return;            // ignora la navegación a about:blank
    if (t) t.url = wc.getURL();
    if (!t || t.activeFocus === 'primary') {
      send({ url: wc.getURL(), ...navState() });
    }
    maybeYouTube(wc);
  };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  wc.on('dom-ready', () => { maybeYouTube(wc); detectPasswordForms(wc, state, id); });
  // Indicador de audio de la pestaña.
  wc.on('audio-state-changed', (ev) => {
    const t = state.tabs.get(id);
    if (!t || t.activeFocus === 'primary') send({ audible: ev.audible });
  });
  // Página de error cuando falla la carga principal (sin conexión, DNS, etc.).
  wc.on('did-fail-load', (_e, code, desc, failUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;          // -3 = navegación abortada
    if (!/^https?:/i.test(failUrl)) return;
    wc.loadFile(path.join(__dirname, 'renderer', 'error.html'), {
      search: `url=${encodeURIComponent(failUrl)}&code=${code}&desc=${encodeURIComponent(desc || '')}`
    });
  });
  // Página de "pestaña bloqueada" si el proceso de render se cae.
  wc.on('render-process-gone', (_e, details) => {
    const u = wc.getURL();
    wc.loadFile(path.join(__dirname, 'renderer', 'crash.html'), {
      search: `url=${encodeURIComponent(u)}&reason=${encodeURIComponent(details?.reason || 'crashed')}`
    });
  });
  wc.on('found-in-page', (_e, r) => {
    const t = state.tabs.get(id);
    if (!t || t.activeFocus === 'primary') state.ui.webContents.send('rave:tab-found', { id, ...r });
  });
  wc.on('context-menu', (_e, p) => {
    const t = state.tabs.get(id);
    if (!t || t.activeFocus === 'primary') state.ui.webContents.send('rave:context-menu', { id, p });
  });
  wc.setWindowOpenHandler(({ url: u }) => { openTab(state, u); return { action: 'deny' }; });

  // Modo solo HTTPS: actualiza la navegación principal de http:// a https://.
  wc.on('will-navigate', (e, navUrl) => {
    if (wantHTTPS() && navUrl.startsWith('http://') && !isLocalUrl(navUrl)) {
      e.preventDefault();
      wc.loadURL(navUrl.replace(/^http:\/\//i, 'https://'));
    }
  });

  // Da de alta la pestaña en el sistema de extensiones (chrome.tabs + acciones).
  if (extensions && !state.incognito) extensions.addTab(wc, state.win);

  wc.loadURL(url);
  state.ui.webContents.send('rave:tab-opened', { id, url });
  selectTab(state, id);
  return state.tabs.get(id);
}

// Suspende (pone en reposo) una pestaña: libera la memoria del sitio cargando
// about:blank, guardando la URL. No destruye la vista (seguro con split-view).
function suspendTab(state, id, force = false) {
  const t = state.tabs.get(id);
  if (!t || t.suspended || t.splitView) return;
  // La pestaña activa no se auto-suspende; en modo manual (force) cambiamos
  // primero a otra pestaña para no dejar la vista en blanco.
  if (state.activeId === id) {
    if (!force) return;
    const others = [...state.tabs.keys()].filter((x) => x !== id);
    if (!others.length) return;        // única pestaña: no suspender
    selectTab(state, others[0]);
  }
  try {
    if (!force && t.view.webContents.isCurrentlyAudible()) return;  // no suspender si suena (auto)
    t.suspendedUrl = t.view.webContents.getURL();
    if (!t.suspendedUrl || t.suspendedUrl === 'about:blank' || t.suspendedUrl.includes('newtab.html')) return;
    t.suspended = true;
    t.view.webContents.loadURL('about:blank');
    state.ui.webContents.send('rave:tab-updated', { id, suspended: true });
  } catch { t.suspended = false; }
}

// Reactiva una pestaña suspendida recargando su URL original.
function wakeTab(state, id) {
  const t = state.tabs.get(id);
  if (!t || !t.suspended) return;
  t.suspended = false;
  const url = t.suspendedUrl;
  t.suspendedUrl = null;
  state.ui.webContents.send('rave:tab-updated', { id, suspended: false });
  if (url) t.view.webContents.loadURL(url);
}

// Auto-reposo: suspende pestañas inactivas más de sleepMs (0 = nunca).
let sleepMs = 10 * 60 * 1000;             // 10 min por defecto (configurable en Ajustes)
setInterval(() => {
  if (sleepMs <= 0) return;
  const now = Date.now();
  for (const state of states.values()) {
    if (state.incognito) continue;        // incógnito no se suspende
    for (const [id, t] of state.tabs) {
      if (id === state.activeId || t.suspended || t.splitView) continue;
      if (now - (t.lastActiveAt || now) > sleepMs) suspendTab(state, id);
    }
  }
}, 15 * 1000);

function selectTab(state, id) {
  if (!state.tabs.has(id)) return;
  // La pestaña que dejamos: arranca su contador de inactividad ahora.
  const prev = state.tabs.get(state.activeId);
  if (prev && state.activeId !== id) prev.lastActiveAt = Date.now();
  const selT = state.tabs.get(id);
  if (selT) { selT.lastActiveAt = Date.now(); if (selT.suspended) wakeTab(state, id); }
  state.activeId = id;
  for (const [tid, t] of state.tabs) {
    const isAct = (tid === id);
    t.view.setVisible(isAct);
    if (t.splitView) t.splitView.setVisible(isAct);
    if (t.dividerView) t.dividerView.setVisible(isAct);
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
  if (t.dividerView) {
    state.win.contentView.removeChildView(t.dividerView);
    t.dividerView.webContents.close();
  }
  state.tabs.delete(id);
  state.ui.webContents.send('rave:tab-closed', { id });
}

function notifyTabUpdated(state, tabId, wc) {
  const t = state.tabs.get(tabId);
  const navState = {
    canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
    canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward()
  };
  state.ui.webContents.send('rave:tab-updated', {
    id: tabId,
    url: wc.getURL(),
    primaryUrl: t ? t.url : undefined,
    splitUrl: t ? t.splitUrl : undefined,
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

  // Limpiar anteriores y ampliar el límite de escuchadores
  wc.setMaxListeners(30);
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
  wc.removeAllListeners('input-event');

  // Registrar nuevos
  const send = (fields) => state.ui.webContents.send('rave:tab-updated', { id: tabId, primaryUrl: t ? t.url : undefined, splitUrl: t ? t.splitUrl : undefined, ...fields });
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

  // Escuchar clics para cambiar el foco de forma robusta en Electron
  wc.on('input-event', (e, inputEvent) => {
    if (inputEvent.type === 'mouseDown') {
      const tab = state.tabs.get(tabId);
      if (tab && tab.splitView && tab.activeFocus !== side) {
        tab.activeFocus = side;
        state.ui.webContents.send('rave:tab-split-focus', { id: tabId, side });
        notifyTabUpdated(state, tabId, wc);
      }
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

  // Crear el dividerView para la redimensión
  const dividerView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  dividerView.setBackgroundColor('#00000000');
  state.win.contentView.addChildView(dividerView);
  dividerView.webContents.loadFile(path.join(__dirname, 'renderer', 'divider.html'));
  tA.dividerView = dividerView;
  tA.splitRatio = tA.splitRatio || 0.5;

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

function toggleSplitTab(state, tabId, newTabUrl, splitRatio, activeSide) {
  const t = state.tabs.get(tabId);
  if (!t) return;

  if (t.splitView) {
    // Volver a separar la pantalla dividida (Convertir la secundaria en pestaña independiente estilo Opera GX)
    const splitWc = t.splitView.webContents;
    const splitView = t.splitView;

    // Crear la nueva pestaña
    const newTabId = tabSeq++;
    const newTab = {
      id: newTabId,
      view: splitView,
      splitView: null,
      splitUrl: null,
      activeFocus: 'primary'
    };

    // Remover la vista secundaria de la pestaña actual
    t.splitView = null;
    t.splitUrl = null;
    t.activeFocus = 'primary';
    if (t.dividerView) {
      state.win.contentView.removeChildView(t.dividerView);
      t.dividerView.webContents.close();
      t.dividerView = null;
    }

    // Registrar la nueva pestaña en el estado
    state.tabs.set(newTabId, newTab);

    // Reconfigurar los escuchadores normales para ambas pestañas
    setupPaneListeners(state, newTabId, 'primary');
    setupPaneListeners(state, tabId, 'primary');

    // Inicializar visualización
    newTab.view.setVisible(false);
    relayout(state);

    // Notificar al renderer
    state.ui.webContents.send('rave:tab-split-state', {
      id: tabId,
      isSplit: false
    });

    state.ui.webContents.send('rave:tab-opened', {
      id: newTabId,
      url: splitWc.getURL()
    });

    // Actualizar estados cromados
    notifyTabUpdated(state, tabId, t.view.webContents);
    notifyTabUpdated(state, newTabId, newTab.view.webContents);

    // Seleccionar la pestaña recién creada
    selectTab(state, newTabId);
  } else {
    // Abrir pantalla dividida
    const splitView = new WebContentsView({
      webPreferences: state.incognito ? { partition: state.partition } : {}
    });
    splitView.setBackgroundColor(state.incognito ? '#0d0d0f' : '#ffffff');
    state.win.contentView.addChildView(splitView, 0);
    
    t.splitView = splitView;
    t.activeFocus = activeSide || 'secondary';
    t.splitRatio = splitRatio || 0.5;

    // Crear el dividerView para la redimensión
    const dividerView = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
    });
    dividerView.setBackgroundColor('#00000000');
    state.win.contentView.addChildView(dividerView);
    dividerView.webContents.loadFile(path.join(__dirname, 'renderer', 'divider.html'));
    t.dividerView = dividerView;

    // Cargar la página nueva pestaña por defecto en la división
    const newTabPath = path.join(__dirname, 'renderer', 'newtab.html');
    if (newTabUrl) {
      splitView.webContents.loadURL(newTabUrl);
    } else {
      splitView.webContents.loadFile(newTabPath);
    }

    // Configurar los escuchadores para ambas partes usando la función helper
    setupPaneListeners(state, tabId, 'primary');
    setupPaneListeners(state, tabId, 'secondary');

    splitView.setVisible(true);
    relayout(state);

    state.ui.webContents.send('rave:tab-split-state', {
      id: tabId,
      isSplit: true,
      activeSide: t.activeFocus
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

// ====== Permisos por sitio ======
const permDecisions = new Map();   // `${origin}|${permission}` -> bool
const pendingPerms = new Map();    // id -> { callback, key }
let permSeq = 1;
function findStateByWC(wc) {
  for (const s of states.values())
    for (const t of s.tabs.values())
      if (t.view?.webContents === wc || t.splitView?.webContents === wc) return s;
  return null;
}
function installPermissions(ses) {
  if (ses.__ravePerms) return; ses.__ravePerms = true;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === 'fullscreen' || permission === 'pointerLock') return callback(true);
    let origin = '';
    try { origin = new URL(details?.requestingUrl || wc.getURL()).origin; } catch {}
    const key = origin + '|' + permission;
    if (permDecisions.has(key)) return callback(permDecisions.get(key));
    const state = findStateByWC(wc);
    if (!state) return callback(false);
    const id = permSeq++;
    pendingPerms.set(id, { callback, key });
    state.ui.webContents.send('rave:permission-request', { id, permission, origin });
  });
}

// ====== Certificados ======
const allowedCertHosts = new Set();
function installCerts(ses) { ses.setCertificateVerifyProc((req, cb) => cb(allowedCertHosts.has(req.hostname) ? 0 : -3)); }

app.on('certificate-error', (event, wc, url, error, _cert, callback) => {
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  if (allowedCertHosts.has(host)) { event.preventDefault(); callback(true); return; }
  event.preventDefault(); callback(false);
  try {
    if (new URL(url).origin === new URL(wc.getURL() || url).origin || wc.getURL() === 'about:blank') {
      wc.loadFile(path.join(__dirname, 'renderer', 'cert-warning.html'),
        { search: `url=${encodeURIComponent(url)}&error=${encodeURIComponent(error)}` });
    }
  } catch {}
});

// Instancia única: si Rave ya está abierto, los enlaces del SO van a esa ventana.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => /^https?:\/\//i.test(a));
    const s = focusedState() || [...states.values()][0];
    if (s) { s.win.focus(); if (url) openTab(s, url); }
  });
}
// URL recibida al arrancar (cuando Rave es el navegador predeterminado).
const initialUrl = () => process.argv.find((a) => /^https?:\/\//i.test(a));

app.whenReady().then(async () => {
  await setupAdblock(session.defaultSession);
  attachDownloads(session.defaultSession);
  installPrivacy(session.defaultSession);
  installPermissions(session.defaultSession);
  installCerts(session.defaultSession);
  try { session.defaultSession.setSpellCheckerLanguages(['es', 'en-US']); } catch {}

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

// Borrar datos de navegación al salir (si está activado en privacidad).
app.on('before-quit', async (e) => {
  if (!privacy.clearOnExit || global.__raveClearing) return;
  e.preventDefault();
  global.__raveClearing = true;
  try {
    await session.defaultSession.clearStorageData();
    await session.defaultSession.clearCache();
  } catch {}
  app.quit();
});

// ====== IPC ======
const st = (e) => {
  const senderId = e.sender.id;
  if (states.has(senderId)) return states.get(senderId);
  for (const s of states.values()) {
    if (s.ui.webContents.id === senderId) return s;
    for (const t of s.tabs.values()) {
      if (t.view.webContents.id === senderId) return s;
      if (t.splitView && t.splitView.webContents.id === senderId) return s;
      if (t.dividerView && t.dividerView.webContents.id === senderId) return s;
    }
  }
  return null;
};

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
ipcMain.on('rave:set-privacy', (_e, p) => { privacy = { ...privacy, ...p }; applyTrackerLevel(); });
ipcMain.on('rave:set-sleep', (_e, minutes) => { sleepMs = minutes > 0 ? minutes * 60000 : 0; });

// Respuesta del usuario al diálogo de permiso
ipcMain.on('rave:permission-response', (_e, { id, allow, remember }) => {
  const p = pendingPerms.get(id); if (!p) return;
  pendingPerms.delete(id);
  if (remember) permDecisions.set(p.key, allow);
  try { p.callback(allow); } catch {}
});

// Imprimir / Guardar como PDF
const activeWc = (e) => { const s = st(e); const t = s && s.tabs.get(s.activeId); return t ? (t.activeFocus === 'secondary' && t.splitView ? t.splitView : t.view).webContents : null; };
ipcMain.on('rave:print', (e) => { try { activeWc(e)?.print(); } catch {} });
ipcMain.handle('rave:print-pdf', async (e) => {
  const wc = activeWc(e); if (!wc) return null;
  try {
    const data = await wc.printToPDF({ printBackground: true });
    const file = path.join(app.getPath('downloads'), `rave-${Date.now()}.pdf`);
    fs.writeFileSync(file, data);
    shell.openPath(file);
    return file;
  } catch { return null; }
});

// Cifrado de contraseñas con safeStorage (cifra con la cuenta del SO)
ipcMain.handle('rave:encrypt', (_e, text) => {
  try {
    if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(String(text)).toString('base64');
  } catch {}
  return 'b64:' + Buffer.from(String(text)).toString('base64');   // respaldo
});
ipcMain.handle('rave:decrypt', (_e, data) => {
  try {
    if (typeof data !== 'string') return '';
    if (data.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(data.slice(4), 'base64'));
    if (data.startsWith('b64:')) return Buffer.from(data.slice(4), 'base64').toString();
    return Buffer.from(data, 'base64').toString();   // formato antiguo (btoa)
  } catch { return ''; }
});

// Importar marcadores de Chrome / Edge / Brave
ipcMain.handle('rave:import-bookmarks', () => {
  const local = process.env.LOCALAPPDATA || path.join(app.getPath('appData'), '..', 'Local');
  const sources = [
    ['Chrome', path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks')],
    ['Edge', path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks')],
    ['Brave', path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Bookmarks')]
  ];
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'url' && node.url) out.push({ title: node.name || node.url, url: node.url });
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  for (const [name, file] of sources) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      Object.values(data.roots || {}).forEach(walk);
      if (out.length) return { source: name, bookmarks: out };
    } catch {}
  }
  return { source: null, bookmarks: [] };
});
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
ipcMain.on('rave:tab-split-toggle', (e, { id, newTabUrl, splitRatio, activeSide }) => { const s = st(e); if (s) toggleSplitTab(s, id, newTabUrl, splitRatio, activeSide); });
ipcMain.on('rave:tab-split-merge', (e, { targetId, sourceId, side }) => { const s = st(e); if (s) mergeTabs(s, targetId, sourceId, side); });

ipcMain.on('rave:divider-drag-start', (e, screenX) => {
  const s = st(e);
  if (!s || s.activeId == null) return;
  const tab = s.tabs.get(s.activeId);
  if (!tab || !tab.splitView) return;
  s.dragStartRatio = tab.splitRatio ?? 0.5;
  s.dragStartX = screenX;
});

ipcMain.on('rave:divider-drag-move', (e, screenX) => {
  const s = st(e);
  if (!s || s.activeId == null || s.dragStartX == null) return;
  const tab = s.tabs.get(s.activeId);
  if (!tab || !tab.splitView) return;
  const [w, h] = s.win.getContentSize();
  if (w <= 0) return;
  const dx = screenX - s.dragStartX;
  tab.splitRatio = Math.max(0.15, Math.min(0.85, s.dragStartRatio + dx / w));
  relayout(s);
  s.ui.webContents.send('rave:tab-split-ratio-updated', { id: s.activeId, splitRatio: tab.splitRatio });
});

ipcMain.on('rave:divider-drag-end', (e) => {
  const s = st(e);
  if (!s) return;
  s.dragStartX = null;
  s.dragStartRatio = null;
  s.ui.webContents.send('rave:save-session');
});
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
    case 'mute': {
      const muted = !!arg;
      t.view.webContents.setAudioMuted(muted);
      if (t.splitView) t.splitView.webContents.setAudioMuted(muted);
      state.ui.webContents.send('rave:tab-updated', { id, muted });
      break;
    }
    case 'suspend': suspendTab(s, id, true); break;
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
