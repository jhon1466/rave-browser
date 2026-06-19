const { app, BaseWindow, WebContentsView, Menu, session, ipcMain, shell, safeStorage, net } = require('electron');
const path = require('path');
const fs = require('fs');

// Eliminar la bandera AutomationControlled que Google usa para detectar Electron
// y bloquear el inicio de sesión ("navegador no seguro").
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');


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
const { isDefaultBrowser, setDefaultBrowser } = require('./defaultBrowser');
const { registerShieldsIPC, installShieldsOnSession, getShields, shieldsAllowSet, setGlobalHttpsOnly } = require('./shields');
const { addHistory, registerHistoryIPC } = require('./history');
const { addToReadingList, registerReadingListIPC } = require('./readinglist');

// Script PiP inyectado via executeJavaScript (corre en el mundo de la página,
// no en contexto aislado, por lo que requestPictureInPicture funciona sin problemas).
const PIP_SCRIPT = fs.readFileSync(path.join(__dirname, 'pip.js'), 'utf8');

// Envía un mensaje a la interfaz de todas las ventanas abiertas.
const broadcast = (ch, data) => { for (const s of states.values()) s.ui.webContents.send(ch, data); };
// ====== Zoom persistente por origen ======
const ZOOM_FILE = () => path.join(app.getPath('userData'), 'zoom.json');
let _zoom = null;
function loadZoom() {
  if (_zoom) return _zoom;
  try { _zoom = JSON.parse(fs.readFileSync(ZOOM_FILE(), 'utf8')); } catch { _zoom = {}; }
  return _zoom;
}
function saveZoom(origin, factor) {
  const z = loadZoom();
  if (factor === 1) delete z[origin]; else z[origin] = factor;
  _zoom = z;
  try { fs.writeFileSync(ZOOM_FILE(), JSON.stringify(z)); } catch {}
}
function getZoom(url) {
  try { return loadZoom()[new URL(url).origin] || 1; } catch { return 1; }
}

// ====== Motores de busqueda personalizados ======
const ENGINES_FILE = () => path.join(app.getPath('userData'), 'search-engines.json');
const DEFAULT_ENGINES = [
  { id: 'google',    name: 'Google',     url: 'https://www.google.com/search?q=%s',         default: false },
  { id: 'ddg',       name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s',               default: true  },
  { id: 'brave',     name: 'Brave',      url: 'https://search.brave.com/search?q=%s',       default: false },
  { id: 'bing',      name: 'Bing',       url: 'https://www.bing.com/search?q=%s',           default: false },
  { id: 'startpage', name: 'Startpage',  url: 'https://www.startpage.com/search?query=%s',  default: false },
];
let _engines = null;
function loadEngines() {
  if (_engines) return _engines;
  try { _engines = JSON.parse(fs.readFileSync(ENGINES_FILE(), 'utf8')); } catch { _engines = [...DEFAULT_ENGINES]; }
  return _engines;
}
function saveEngines(engines) { _engines = engines; try { fs.writeFileSync(ENGINES_FILE(), JSON.stringify(engines)); } catch {} }
function getDefaultEngine() { return loadEngines().find(e => e.default) || DEFAULT_ENGINES[1]; }
function getSearchUrl(query) { return getDefaultEngine().url.replace('%s', encodeURIComponent(query)); }


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


// Solo estiliza la barra de scroll PRINCIPAL del documento (html/body).
// No usamos un selector global porque `::-webkit-scrollbar` con !important
// anula el `display:none` que sitios como Facebook ponen a sus contenedores
// internos, haciendo aparecer un segundo scrollbar.
const SCROLLBAR_CSS = `
  html::-webkit-scrollbar, body::-webkit-scrollbar { width: 10px; height: 10px; }
  html::-webkit-scrollbar-track, body::-webkit-scrollbar-track { background: transparent; }
  html::-webkit-scrollbar-thumb, body::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.4); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
  html::-webkit-scrollbar-thumb:hover, body::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.65); background-clip: padding-box; }
`;

const COOKIE_CONSENT_CSS = `
  #cookie-banner, #cookie-notice, #cookie-popup, #cookie-bar,
  #cookiebanner, #cookieConsent, #cookie-consent, #cookie_consent,
  .cookie-banner, .cookie-notice, .cookie-popup, .cookie-bar,
  .cookiebanner, .cookieConsent, .cookie-consent, .cookie_consent,
  [id*="cookie-banner"], [id*="cookie-notice"], [id*="cookiebanner"],
  [class*="cookie-banner"], [class*="cookie-notice"],
  #CybotCookiebotDialog, #onetrust-banner-sdk, .cc-window,
  #gdpr-banner, .gdpr-banner, [id*="gdpr"], [class*="gdpr-popup"],
  #sp-cc, .sp-message-container, #qc-cmp2-container,
  .fc-dialog-container, #usercentrics-root, #didomi-popup,
  #cookielaw-icon, .pea_cook_wrapper { display: none !important; }
  body { overflow: auto !important; }
`;

// ====== Creación de ventanas ======
function createWindow(incognito = false) {
  let partition = null, tabSession = session.defaultSession;
  if (incognito) {
    partition = 'incognito-' + Date.now();
    tabSession = session.fromPartition(partition);   // en memoria (sin persist:)
    cleanUserAgent(tabSession);
    if (privacy.level !== 'off') enableBlockingOn(tabSession);
    attachDownloads(tabSession);
    installPrivacy(tabSession);
    installPermissions(tabSession);
    installCerts(tabSession);
    installShieldsOnSession(tabSession);
  }

  const ws = incognito ? null : loadWinState();
  const win = new BaseWindow({
    width: ws?.width || 1280, height: ws?.height || 800,
    x: ws?.x, y: ws?.y,
    minWidth: 720, minHeight: 420,
    frame: false, backgroundColor: incognito ? '#0d0d0f' : '#ffffff', title: 'Rave',
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
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

  // Al restaurar desde minimizado, forzar repintado de todas las vistas
  const repaintAll = () => {
    ui.webContents.invalidate();
    for (const t of state.tabs.values()) {
      t.view?.webContents?.invalidate();
      t.splitView?.webContents?.invalidate();
    }
  };
  win.on('restore', repaintAll);
  win.on('show', repaintAll);

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
        // Ocultar el divisor cuando hay un overlay activo (ajustes, panel, menú)
        // para que no quede flotando encima del modal.
        tab.dividerView.setVisible(!state.overlay);
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

// Abre accounts.google.com en una ventana real (BrowserWindow) con un preload
// que limpia las señales de Electron en el MUNDO REAL de la página, SIN usar el
// depurador/CDP (que Google detecta como automatización). La sesión es la
// principal, así las cookies del login quedan disponibles en Rave.
function openGoogleAuthWindow(url, originWc, parentWin) {
  const { BrowserWindow } = require('electron');
  const chromeUA = chromeUAString();
  const popup = new BrowserWindow({
    width: 500, height: 640,
    parent: parentWin,
    title: 'Iniciar sesión con Google',
    autoHideMenuBar: true,
    webPreferences: {
      session: session.defaultSession,
      nodeIntegration: false,
      // contextIsolation:false permite que el preload corra en el mundo real
      // y pueda sobrescribir navigator.* antes que los scripts de Google.
      contextIsolation: false,
      sandbox: false,
      preload: path.join(__dirname, 'google-auth-preload.js')
    }
  });
  popup.webContents.setUserAgent(chromeUA);
  popup.webContents.session.setUserAgent(chromeUA);
  popup.loadURL(url);
  const onNav = (_e, navUrl) => {
    if (!navUrl.includes('accounts.google.com') && !navUrl.includes('google.com/signin')) {
      if (!popup.isDestroyed()) popup.close();
      if (!originWc.isDestroyed()) originWc.reload();
    }
  };
  popup.webContents.on('did-navigate', onNav);
}

// Detecta si una URL es un popup de autenticación OAuth que necesita window.opener
function isAuthPopupUrl(u) {
  return /accounts\.google\.com|appleid\.apple\.com|facebook\.com\/dialog|twitter\.com\/oauth|github\.com\/login\/oauth|login\.microsoftonline\.com|discord\.com\/oauth2|auth\d*\.|oauth\.|\/oauth|\/login\/oauth|sso\.|\/signin|\/authorize\?/i.test(u);
}

function makeWindowOpenHandler(state) {
  return ({ url: u, features }) => {
    if (isAuthPopupUrl(u) || (features && /popup|width=\d{2,3},height=\d{2,3}/.test(features))) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520, height: 680, resizable: true,
          webPreferences: {
            partition: state.incognito ? state.partition : undefined,
            nodeIntegration: false, contextIsolation: true, sandbox: true
          }
        }
      };
    }
    openTab(state, u);
    return { action: 'deny' };
  };
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
    if (!t || t.activeFocus === 'primary') {
      send({ title });
      if (!state.incognito) addHistory(t ? t.url || wc.getURL() : wc.getURL(), title, t && t.favicon);
    }
  });
  wc.on('page-favicon-updated', (_e, favicons) => {
    const t = state.tabs.get(id);
    if (!t || t.activeFocus === 'primary') send({ favicon: favicons && favicons[0] });
  });
  const onNav = () => {
    const t = state.tabs.get(id);
    if (t && t.suspended) return;            // ignora la navegación a about:blank
    if (t) { t.url = wc.getURL(); t._readerCssKey = null; }
    if (!t || t.activeFocus === 'primary') {
      send({ url: wc.getURL(), ...navState() });
    }
    maybeYouTube(wc);
  };
  wc.on('did-navigate', (e, url) => { onNav(); const z = getZoom(url); if (z !== 1) wc.setZoomFactor(z); });
  wc.on('did-navigate-in-page', onNav);
  wc.on('dom-ready', () => { maybeYouTube(wc); detectPasswordForms(wc, state, id); wc.executeJavaScript(PIP_SCRIPT, true).catch(() => {}); });
  // Indicador de audio de la pestaña.
  wc.on('audio-state-changed', () => {
    const t = state.tabs.get(id);
    const audible = wc.isCurrentlyAudible();
    if (!t || t.activeFocus === 'primary') send({ audible });
    // Notificar al chrome sobre el estado de medios global
    state.ui.webContents.send('rave:media-state', { id, playing: audible });
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
    if (!t || t.activeFocus === 'primary') {
      // El panel primario empieza en x=0, sin offset
      state.ui.webContents.send('rave:context-menu', { id, p: { ...p, x: p.x, panelOffsetX: 0 } });
    }
  });
  const normalOpenHandler = makeWindowOpenHandler(state);
  wc.setWindowOpenHandler((details) => {
    if (details.url.includes('accounts.google.com')) {
      openGoogleAuthWindow(details.url, wc, state.win);
      return { action: 'deny' };
    }
    return normalOpenHandler(details);
  });

  // Cuando el usuario hace clic en el lado primario, recuperar el foco si estaba en el secundario
  wc.on('input-event', (_e, inputEvent) => {
    if (inputEvent.type !== 'mouseDown') return;
    const t = state.tabs.get(id);
    if (t && t.splitView && t.activeFocus !== 'primary') {
      t.activeFocus = 'primary';
      state.ui.webContents.send('rave:tab-split-focus', { id, side: 'primary' });
      notifyTabUpdated(state, id, wc);
    }
  });

  // Modo solo HTTPS + login de Google en ventana real (sin CDP).
  wc.on('will-navigate', (e, navUrl) => {
    if (navUrl.includes('accounts.google.com')) {
      e.preventDefault();
      openGoogleAuthWindow(navUrl, wc, state.win);
      return;
    }
    if (wantHTTPS() && navUrl.startsWith('http://') && !isLocalUrl(navUrl)) {
      e.preventDefault();
      wc.loadURL(navUrl.replace(/^http:\/\//i, 'https://'));
    }
  });

  // Da de alta la pestaña en el sistema de extensiones (chrome.tabs + acciones).
  if (extensions && !state.incognito && !wc.isDestroyed()) {
    try { extensions.addTab(wc, state.win); } catch {}
  }

  // Si la página cierra su propia ventana (p. ej. popup de login OAuth),
  // cerramos la pestaña en vez de dejar un webContents muerto.
  wc.on('destroyed', () => { if (state.tabs.has(id)) closeTab(state, id); });

  // Fullscreen HTML5 (videos, juegos, etc.) → ocultar chrome completamente
  wc.on('enter-html-full-screen', () => {
    state._savedChromeH = state.chromeH;
    state.chromeH = 0;
    state.ui.setBounds({ x: 0, y: 0, width: 1, height: 1 }); // casi invisible pero vivo
    relayout(state);
  });
  wc.on('leave-html-full-screen', () => {
    state.chromeH = state._savedChromeH ?? 96;
    const [w, h] = state.win.getContentSize();
    state.ui.setBounds({ x: 0, y: 0, width: w, height: Math.round(state.chromeH) });
    relayout(state);
  });

  // Ctrl+rueda del ratón → zoom
  wc.on('zoom-changed', (_e, direction) => {
    const t = state.tabs.get(id);
    if (!t) return;
    const delta = direction === 'in' ? 0.1 : -0.1;
    const z = Math.min(3, Math.max(0.25, Math.round(((t.zoom || 1) + delta) * 10) / 10));
    t.zoom = z;
    wc.setZoomFactor(z);
    try { saveZoom(new URL(wc.getURL()).origin, z); } catch {}
    state.ui.webContents.send('rave:tab-updated', { id, zoom: z });
  });

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
    if (t.dividerView) t.dividerView.setVisible(isAct && !state.overlay);
  }
  relayout(state);
  const selWc = state.tabs.get(id)?.view?.webContents;
  if (extensions && !state.incognito && selWc && !selWc.isDestroyed()) {
    try { extensions.selectTab(selWc); } catch {}
  }
  state.ui.webContents.send('rave:tab-activated', { id });
  
  // Sincronizar estado de pantalla dividida a la UI
  const t = state.tabs.get(id);
  state.ui.webContents.send('rave:tab-split-state', {
    id,
    isSplit: !!t.splitView,
    activeSide: t.activeFocus || 'primary',
    primaryUrl: t.view.webContents.getURL(),
    splitUrl: t.splitView ? t.splitView.webContents.getURL() : null
  });
}

function closeTab(state, id) {
  const t = state.tabs.get(id);
  if (!t) return;
  state.tabs.delete(id);   // primero, para evitar reentradas desde 'destroyed'
  const dispose = (view) => {
    if (!view) return;
    try { state.win.contentView.removeChildView(view); } catch {}
    try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch {}
  };
  dispose(t.view);
  dispose(t.splitView);
  dispose(t.dividerView);
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
    const url = wc.getURL();
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    if (side === 'primary') tab.url = url;
    else tab.splitUrl = url;
    // Solo actualizar la barra de direcciones si este lado tiene el foco
    if (tab.activeFocus === side) send({ url, ...navState() });
    maybeYouTube(wc);
  };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  wc.on('dom-ready', () => { maybeYouTube(wc); detectPasswordForms(wc, state, tabId); wc.executeJavaScript(PIP_SCRIPT, true).catch(() => {}); });
  wc.on('found-in-page', (_e, r) => {
    const tab = state.tabs.get(tabId);
    if (tab && tab.activeFocus === side) state.ui.webContents.send('rave:tab-found', { id: tabId, ...r });
  });
  wc.on('context-menu', (_e, p) => {
    const tab = state.tabs.get(tabId);
    if (tab && tab.activeFocus === side) {
      // Calcular el offset X real del panel dentro de la ventana
      const view = (side === 'primary') ? tab.view : tab.splitView;
      const panelOffsetX = view ? view.getBounds().x : 0;
      state.ui.webContents.send('rave:context-menu', { id: tabId, p: { ...p, panelOffsetX } });
    }
  });
  wc.setWindowOpenHandler(makeWindowOpenHandler(state));

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

  wc.on('enter-html-full-screen', () => {
    state._savedChromeH = state.chromeH;
    state.chromeH = 0;
    state.ui.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    relayout(state);
  });
  wc.on('leave-html-full-screen', () => {
    state.chromeH = state._savedChromeH ?? 96;
    const [w, h] = state.win.getContentSize();
    state.ui.setBounds({ x: 0, y: 0, width: w, height: Math.round(state.chromeH) });
    relayout(state);
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
    activeSide: tA.activeFocus,
    primaryUrl: tA.view.webContents.getURL(),
    splitUrl: tA.splitView ? tA.splitView.webContents.getURL() : null
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
      webPreferences: state.incognito
        ? { partition: state.partition, spellcheck: true }
        : { spellcheck: true }
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
      activeSide: t.activeFocus,
      primaryUrl: t.view.webContents.getURL(),
      splitUrl: t.splitView ? t.splitView.webContents.getURL() : null
    });
  }
}

function maybeYouTube(wc) {
  if (/(^|\.)youtube\.com|youtube-nocookie\.com/.test(wc.getURL()))
    wc.executeJavaScript(YT_ADSKIP, true).catch(() => {});
  wc.insertCSS(COOKIE_CONSENT_CSS).catch(() => {});
  wc.insertCSS(SCROLLBAR_CSS).catch(() => {});
  wc.executeJavaScript(SCROLLFIX_JS, true).catch(() => {});
}

// Corrige el patrón de doble scrollbar: cuando <html> y <body> son AMBOS
// desplazables (html overflow:scroll + body overflow:auto, típico de Facebook),
// se muestran dos barras. Hacemos que el body fluya al html para dejar una sola.
const SCROLLFIX_JS = `(function(){
  if (window.__raveScrollFix) return; window.__raveScrollFix = true;
  function isScroll(o){ return o==='scroll'||o==='auto'; }
  function fix(){
    var h=document.documentElement, b=document.body;
    if(!b) return;
    var ho=getComputedStyle(h).overflowY, bo=getComputedStyle(b).overflowY;
    // Patrón doble-barra (Facebook): html y body son AMBOS scrollables y anidados.
    // El body queda a su altura natural (mayor que la ventana) en vez de 100vh,
    // por lo que el html también desborda -> dos barras. Forzamos el body a altura
    // de ventana para que sea el ÚNICO contenedor de scroll (el del feed infinito)
    // y el html deje de desbordar.
    if(isScroll(ho) && isScroll(bo)){
      h.style.setProperty('overflow','hidden','important');
      b.style.setProperty('height','100vh','important');
      b.style.setProperty('max-height','100vh','important');
      b.style.setProperty('overflow-y','auto','important');
    }
  }
  fix();
  var n=0, t=setInterval(function(){ fix(); if(++n>15) clearInterval(t); }, 500);
})();`;

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
// Mueve/copia un archivo gestionando colisiones de nombre
function moveFile(src, dest) {
  try { fs.renameSync(src, dest); return dest; } catch {}
  fs.copyFileSync(src, dest); try { fs.unlinkSync(src); } catch {}
  return dest;
}
function uniqueDest(dir, name) {
  let dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name), base = path.basename(name, ext);
  dest = path.join(dir, `${base}-${Date.now()}${ext}`);
  return dest;
}

const activeDownloads = new Map(); // id → DownloadItem

function attachDownloads(ses) {
  if (ses.__raveDownloads) return;
  ses.__raveDownloads = true;
  ses.on('will-download', (_e, item) => {
    // Interceptar PDFs y abrirlos en una nueva pestaña en lugar de descargarlos
    const mime = item.getMimeType();
    const url = item.getURL();
    const isPDF = mime === 'application/pdf' || url.toLowerCase().split('?')[0].endsWith('.pdf');
    if (isPDF) {
      _e.preventDefault();
      for (const s of states.values()) {
        if (s.tabSession === ses || (ses === session.defaultSession && !s.incognito)) {
          s.ui.webContents.send('rave:open-pdf', url);
          break;
        }
      }
      return;
    }
    const name = item.getFilename();
    const total = item.getTotalBytes();
    const defaultDest = uniqueDest(app.getPath('downloads'), name);

    // Preguntar al usuario dónde guardar ANTES de descargar
    const { dialog } = require('electron');
    const chosen = dialog.showSaveDialogSync({
      title: 'Guardar archivo',
      defaultPath: defaultDest,
      buttonLabel: 'Guardar'
    });

    if (!chosen) {
      // Usuario canceló → cancelar la descarga
      item.cancel();
      return;
    }

    item.setSavePath(chosen);

    const id = `dl-${Date.now()}`;
    const info = { id, name, total, destPath: chosen };
    const bcast = (ch, extra) => { for (const s of states.values()) s.ui.webContents.send(ch, { ...info, ...extra }); };

    activeDownloads.set(id, item);
    bcast('rave:download-started');

    item.on('updated', (_ev, st) => {
      if (st === 'progressing') {
        bcast('rave:download-progress', { received: item.getReceivedBytes(), paused: false });
      } else if (st === 'interrupted') {
        bcast('rave:download-progress', { received: item.getReceivedBytes(), paused: true });
      }
    });

    item.once('done', (_ev, st) => {
      activeDownloads.delete(id);
      bcast('rave:download-done', { state: st, destPath: st === 'completed' ? chosen : null });
    });
  });
}

// Los IPC de descarga se registran una sola vez al arrancar (no dentro de attachDownloads)
function registerDownloadIPC() {
  ipcMain.handle('rave:download-open', async (_e, { destPath }) => {
    const err = await require('electron').shell.openPath(destPath);
    return { ok: !err, err };
  });

  ipcMain.handle('rave:download-save', async (_e, { destPath, name }) => {
    const { dialog } = require('electron');
    const dest = dialog.showSaveDialogSync({ defaultPath: path.join(app.getPath('downloads'), name) });
    if (!dest) return { cancelled: true };
    if (dest !== destPath) moveFile(destPath, dest);
    return { saved: dest };
  });

  ipcMain.on('rave:download-pause', (_e, { id }) => {
    const item = activeDownloads.get(id);
    if (item && !item.isPaused()) item.pause();
  });

  ipcMain.on('rave:download-resume', (_e, { id }) => {
    const item = activeDownloads.get(id);
    if (item && item.isPaused() && item.canResume()) item.resume();
  });

  ipcMain.on('rave:download-cancel', (_e, { id }) => {
    const item = activeDownloads.get(id);
    if (item) { item.cancel(); activeDownloads.delete(id); }
  });

  ipcMain.on('rave:download-url', (_e, url) => {
    let tabSes = null;
    for (const s of states.values()) {
      const t = s.tabs.get(s.activeId);
      if (t && !t.view.webContents.isDestroyed()) { tabSes = t.view.webContents.session; break; }
    }
    (tabSes || require('electron').session.defaultSession).downloadURL(url);
  });

  ipcMain.handle('rave:download-delete', async (_e, { destPath }) => {
    try { if (destPath && fs.existsSync(destPath)) fs.unlinkSync(destPath); return { ok: true }; }
    catch (e) { return { ok: false, err: e.message }; }
  });

  ipcMain.handle('rave:download-show', async (_e, { destPath }) => {
    require('electron').shell.showItemInFolder(destPath);
    return { ok: true };
  });
}

// ====== Arranque ======
registerDownloadIPC();
Menu.setApplicationMenu(null);
process.on('unhandledRejection', (err) => {
  const m = (err && err.message) || String(err);
  if (m.includes('Script failed to execute') || m.includes('disposed')) return;
  console.error('[Rave] unhandledRejection:', m);
});
// Red de seguridad: un error puntual (p. ej. webContents destruido durante un
// login) no debe cerrar todo el navegador. Lo registramos y seguimos.
process.on('uncaughtException', (err) => {
  console.error('[Rave] uncaughtException:', (err && err.stack) || err);
});

// ====== Permisos por sitio ======
// Estructura: { [origin]: { [permission]: 'allow'|'block' } }
const permsFile = path.join(app.getPath('userData'), 'site-permissions.json');
function loadPerms() {
  try { return JSON.parse(fs.readFileSync(permsFile, 'utf8')); } catch { return {}; }
}
function savePerms(data) {
  try { fs.writeFileSync(permsFile, JSON.stringify(data, null, 2)); } catch { }
}
let sitePerms = loadPerms();   // persistido en disco

// Popula permDecisions desde el archivo al arrancar
const permDecisions = new Map();
for (const [origin, perms] of Object.entries(sitePerms))
  for (const [perm, val] of Object.entries(perms))
    permDecisions.set(origin + '|' + perm, val === 'allow');

const pendingPerms = new Map();    // id -> { callback, key, origin, permission }
let permSeq = 1;
function findStateByWC(wc) {
  for (const s of states.values())
    for (const t of s.tabs.values())
      if (t.view?.webContents === wc || t.splitView?.webContents === wc) return s;
  return null;
}
function setPerm(origin, permission, allow) {
  permDecisions.set(origin + '|' + permission, allow);
  if (!sitePerms[origin]) sitePerms[origin] = {};
  sitePerms[origin][permission] = allow ? 'allow' : 'block';
  savePerms(sitePerms);
}
function deletePerm(origin, permission) {
  permDecisions.delete(origin + '|' + permission);
  if (sitePerms[origin]) {
    delete sitePerms[origin][permission];
    if (!Object.keys(sitePerms[origin]).length) delete sitePerms[origin];
  }
  savePerms(sitePerms);
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
    pendingPerms.set(id, { callback, key, origin, permission });
    state.ui.webContents.send('rave:permission-request', { id, permission, origin });
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    // fullscreen/pointerLock se conceden igual que en el request handler.
    if (permission === 'fullscreen' || permission === 'pointerLock') return true;
    // El resto: solo si hay una decisión guardada que lo permita. Por defecto
    // se DENIEGA (antes devolvía true, concediendo cualquier comprobación de
    // permiso sin consentimiento). Las solicitudes reales siguen pasando por
    // setPermissionRequestHandler, que pregunta al usuario y guarda la decisión.
    const key = (requestingOrigin || (wc ? wc.getURL() : '')) + '|' + permission;
    return permDecisions.has(key) ? permDecisions.get(key) : false;
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

// User-Agent "limpio": elimina los tokens Electron/Rave para que sitios que
// hacen sniffing de UA (Facebook, etc.) sirvan el layout normal de Chrome y no
// una versión degradada (que muestra scrollbars internos de más, entre otros).
// UA de Chrome completo y consistente con la versión de Chromium que trae
// Electron. Construirlo entero (en vez de recortar el de Electron) evita que
// Google marque el navegador como "no seguro" por una cadena UA atípica.
// Versión de Chrome estable y real que anunciamos (no la de Electron, que va
// por delante y Google puede marcar como falsa). Mantener actualizada a una
// versión estable existente.
const SPOOF_CHROME_VERSION = '136.0.0.0';
function chromeUAString() {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${SPOOF_CHROME_VERSION} Safari/537.36`;
}
function cleanUserAgent(ses) {
  try { ses.setUserAgent(chromeUAString()); } catch {}
}

app.whenReady().then(async () => {
  cleanUserAgent(session.defaultSession);
  await setupAdblock(session.defaultSession);
  attachDownloads(session.defaultSession);
  installPrivacy(session.defaultSession);
  installPermissions(session.defaultSession);
  installCerts(session.defaultSession);
  installShieldsOnSession(session.defaultSession);
  registerShieldsIPC();
  registerHistoryIPC();
  registerReadingListIPC();
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
  const startState = createWindow();
  // Si el SO abrió Rave con un enlace (navegador predeterminado), lo cargamos.
  const u = initialUrl();
  if (u && startState) openTab(startState, u);
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
ipcMain.handle('rave:is-default-browser', () => isDefaultBrowser());
ipcMain.handle('rave:set-default-browser', () => setDefaultBrowser());
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
ipcMain.on('rave:set-privacy', (_e, p) => {
  privacy = { ...privacy, ...p };
  setGlobalHttpsOnly(privacy.httpsOnly || privacy.level === 'strict');
  applyTrackerLevel();
});
ipcMain.on('rave:set-sleep', (_e, minutes) => { sleepMs = minutes > 0 ? minutes * 60000 : 0; });

// Respuesta del usuario al diálogo de permiso
ipcMain.on('rave:permission-response', (_e, { id, allow, remember }) => {
  const p = pendingPerms.get(id); if (!p) return;
  pendingPerms.delete(id);
  if (remember) setPerm(p.origin, p.permission, allow);
  else permDecisions.set(p.key, allow);
  try { p.callback(allow); } catch {}
});

// CRUD de permisos por sitio
ipcMain.handle('rave:get-site-perms', (_e, origin) => sitePerms[origin] || {});
ipcMain.handle('rave:get-all-perms', () => sitePerms);
ipcMain.handle('rave:set-site-perm', (_e, { origin, permission, value }) => {
  if (value === 'default') deletePerm(origin, permission);
  else setPerm(origin, permission, value === 'allow');
  return true;
});
ipcMain.handle('rave:delete-site-perms', (_e, origin) => {
  for (const perm of Object.keys(sitePerms[origin] || {})) permDecisions.delete(origin + '|' + perm);
  delete sitePerms[origin];
  savePerms(sitePerms);
  return true;
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

// Info de seguridad del sitio activo
ipcMain.handle('rave:get-site-info', async (e) => {
  const s = st(e);
  if (!s || !s.activeId) return null;
  const tab = s.tabs.get(s.activeId);
  if (!tab) return null;
  const targetView = (tab.splitView && tab.activeFocus === 'secondary') ? tab.splitView : tab.view;
  const wc = targetView.webContents;
  const url = wc.getURL();
  let cert = null;
  try {
    const info = wc.getProcessId ? wc : null;
    const certData = wc.getCertificate ? wc.getCertificate() : null;
    if (certData) {
      cert = {
        issuer: certData.issuerName || certData.issuer?.commonName || '',
        subject: certData.subjectName || certData.subject?.commonName || '',
        validStart: certData.validStart,
        validExpiry: certData.validExpiry,
      };
    }
  } catch { }
  let cookieCount = 0;
  try {
    const ses = s.tabSession || session.defaultSession;
    const cookies = await ses.cookies.get({ url });
    cookieCount = cookies.length;
  } catch { }
  const blockedCount = global.__raveBlockedCount || 0;
  let origin = ''; try { origin = new URL(url).origin; } catch {}
  const perms = sitePerms[origin] || {};
  const shields = getShields(origin);
  return { url, cert, cookieCount, blockedCount, origin, perms, shields };
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
  if (!s || !s.activeId) return { ok: false };
  const tab = s.tabs.get(s.activeId);
  if (!tab) return { ok: false };
  try {
    const targetView = (tab.splitView && tab.activeFocus === 'secondary') ? tab.splitView : tab.view;
    const wc = targetView.webContents;
    if (tab._readerCssKey) {
      await wc.removeInsertedCSS(tab._readerCssKey);
      tab._readerCssKey = null;
      return { ok: true, active: false };
    } else {
      tab._readerCssKey = await wc.insertCSS(READER_CSS);
      return { ok: true, active: true };
    }
  } catch { return { ok: false }; }
});

// Pestañas
ipcMain.handle('rave:tab-create', (e, url) => { const s = st(e); return s ? openTab(s, url).id : null; });
// Fijar / desfijar pestaña
ipcMain.on('rave:tab-pin', (_e, { id }) => {
  const s = st(_e); if (!s) return;
  const tab = s.tabs.get(id); if (!tab) return;
  tab.pinned = !tab.pinned;
  s.ui.webContents.send('rave:tab-updated', { id, pinned: tab.pinned });
});

// Motores de busqueda
ipcMain.handle('rave:get-engines', () => loadEngines());
ipcMain.handle('rave:set-default-engine', (_e, id) => {
  const engines = loadEngines();
  engines.forEach(e => e.default = e.id === id);
  saveEngines(engines);
  return engines;
});
ipcMain.handle('rave:add-engine', (_e, { name, url }) => {
  const engines = loadEngines();
  engines.push({ id: Date.now().toString(), name, url, default: false });
  saveEngines(engines);
  return engines;
});
ipcMain.handle('rave:delete-engine', (_e, id) => {
  let engines = loadEngines().filter(e => e.id !== id);
  if (!engines.find(e => e.default) && engines.length) engines[0].default = true;
  saveEngines(engines);
  return engines;
});

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
    case 'zoom': wc.setZoomFactor(arg); try { saveZoom(new URL(wc.getURL()).origin, arg); } catch {} break;
    case 'find': wc.findInPage(arg.text, arg.opts); break;
    case 'stopFind': wc.stopFindInPage('clearSelection'); break;
    case 'share': { const { clipboard } = require('electron'); clipboard.writeText(wc.getURL()); break; }
    case 'rl-add': { const ti = t ? t.title : wc.getTitle(); const fa = t ? t.favicon : ''; addToReadingList(wc.getURL(), ti, fa); break; }
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

// Helper: petición HTTPS con Node.js nativo (sin CORS, sin CSP)
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    require('https').get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function googleTranslate(text, tl) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
  const raw = await httpsGet(url);
  const data = JSON.parse(raw);
  // data[0] = array de segmentos [[traducido, original], ...]
  const translated = data[0].filter(Boolean).map((c) => c[0] || '').join('');
  const detectedLang = (data[2] && typeof data[2] === 'string') ? data[2] : 'auto';
  return { translated, detectedLang };
}

// Traducción de texto seleccionado
ipcMain.handle('rave:translate', async (_e, { text, tl }) => {
  try {
    const result = await googleTranslate(text, tl);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Traducción de página completa: extrae textos desde main, traduce allí, reinyecta
ipcMain.handle('rave:translate-page', async (e, { tl }) => {
  const s = st(e); if (!s) return { ok: false };
  const t = s.tabs.get(s.activeId); if (!t) return { ok: false };
  const wc = (t.activeFocus === 'secondary' && t.splitView) ? t.splitView.webContents : t.view.webContents;

  try {
    // 1. Extraer textos originales y guardar backup en la propia página
    const extractScript = `(function() {
      const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT','SELECT','CODE','PRE','KBD','SAMP']);
      const results = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let i = 0;
      while (walker.nextNode()) {
        const n = walker.currentNode;
        const text = n.textContent.trim();
        if (!text || text.length < 2) continue;
        let skip = false, p = n.parentElement;
        while (p) { if (SKIP.has(p.tagName)) { skip = true; break; } p = p.parentElement; }
        if (!skip) {
          n.__raveIdx = i;
          if (n.__raveOrig === undefined) n.__raveOrig = n.textContent; // guardar original solo una vez
          results.push({ idx: i, text: n.__raveOrig }); // siempre traducir desde el original
          i++;
        }
      }
      return JSON.stringify(results);
    })()`;

    const extracted = JSON.parse(await wc.executeJavaScript(extractScript));
    if (!extracted.length) return { ok: false, error: 'Sin texto' };

    // 2. Traducir en lotes desde el proceso principal (sin fetch en la página)
    const BATCH = 50;
    const translations = new Array(extracted.length);
    for (let i = 0; i < extracted.length; i += BATCH) {
      const batch = extracted.slice(i, i + BATCH);
      const SEP = '\n⁣\n';
      const combined = batch.map((x) => x.text).join(SEP);
      try {
        const { translated } = await googleTranslate(combined, tl);
        const parts = translated.split(/\n[^\S\n]*⁣[^\S\n]*\n/);
        batch.forEach((item, j) => { translations[i + j] = { idx: item.idx, text: (parts[j] || item.text).trim() }; });
      } catch {
        batch.forEach((item, j) => { translations[i + j] = { idx: item.idx, text: item.text }; });
      }
    }

    // 3. Reinyectar por índice
    const map = Object.fromEntries(translations.filter(Boolean).map((x) => [x.idx, x.text]));
    await wc.executeJavaScript(`(function(map){
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while(walker.nextNode()){const n=walker.currentNode;if(n.__raveIdx!==undefined&&map[n.__raveIdx]!==undefined)n.textContent=map[n.__raveIdx];}
    })(${JSON.stringify(map)})`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('rave:restore-page', async (e) => {
  const s = st(e); if (!s) return { ok: false };
  const t = s.tabs.get(s.activeId); if (!t) return { ok: false };
  const wc = (t.activeFocus === 'secondary' && t.splitView) ? t.splitView.webContents : t.view.webContents;
  try {
    await wc.executeJavaScript(`(function(){
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while(walker.nextNode()){const n=walker.currentNode;if(n.__raveOrig!==undefined){n.textContent=n.__raveOrig;delete n.__raveOrig;delete n.__raveIdx;}}
    })()`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Disposición
ipcMain.on('rave:set-layout', (e, { chromeH }) => { const s = st(e); if (s) { s.chromeH = chromeH; relayout(s); } });
ipcMain.on('rave:set-overlay', (e, on) => { const s = st(e); if (s) { s.overlay = on; relayout(s); } });

// Portapapeles (texto) lo maneja el preload con clipboard.

// Controles de ventana
ipcMain.on('rave:pip', () => {
  const state = focusedState(); if (!state) return;
  const tab = state.tabs.get(state.activeId); if (!tab) return;
  const wc = (tab.activeFocus === 'secondary' && tab.splitView) ? tab.splitView.webContents : tab.view.webContents;
  wc.executeJavaScript(`
    (function(){
      const v = document.querySelector('video:not([disablepictureinpicture])');
      if(v) v.requestPictureInPicture().catch(()=>{});
    })()
  `).catch(() => {});
});

// ====== Vista previa de pestaña ======
ipcMain.handle('rave:tab-preview', async (_e, id) => {
  for (const s of states.values()) {
    const tab = s.tabs.get(id);
    if (tab?.view) {
      try {
        const img = await tab.view.webContents.capturePage();
        const resized = img.resize({ width: 280, height: 158 });
        return resized.toDataURL();
      } catch { return null; }
    }
  }
  return null;
});

// ====== Controles de medios ======
ipcMain.on('rave:media-control', (_e, action) => {
  const state = focusedState(); if (!state) return;
  const tab = state.tabs.get(state.activeId); if (!tab) return;
  const script = action === 'play'  ? `document.querySelector('video,audio')?.play()`
               : action === 'pause' ? `document.querySelector('video,audio')?.pause()`
               : action === 'prev'  ? `window.mediaSession?.callActionHandler?.('previoustrack', null)`
               : action === 'next'  ? `window.mediaSession?.callActionHandler?.('nexttrack', null)`
               : null;
  if (script) tab.view.webContents.executeJavaScript(script).catch(() => {});
});

ipcMain.handle('rave:media-info', async (_e) => {
  const state = focusedState(); if (!state) return null;
  const tab = state.tabs.get(state.activeId); if (!tab) return null;
  try {
    return await tab.view.webContents.executeJavaScript(`
      ({
        playing: !!(document.querySelector('video,audio') && !document.querySelector('video,audio').paused),
        title: navigator.mediaSession?.metadata?.title || document.title,
        artist: navigator.mediaSession?.metadata?.artist || '',
        artwork: navigator.mediaSession?.metadata?.artwork?.[0]?.src || ''
      })
    `);
  } catch { return null; }
});

ipcMain.on('rave:win-minimize', (e) => st(e)?.win.minimize());
ipcMain.on('rave:win-maximize', (e) => { const w = st(e)?.win; if (!w) return; w.isMaximized() ? w.unmaximize() : w.maximize(); });
ipcMain.on('rave:win-close', (e) => st(e)?.win.close());
ipcMain.handle('rave:win-is-maximized', (e) => st(e)?.win.isMaximized() ?? false);

// Generador de QR
ipcMain.handle('rave:qr-generate', async (_e, url) => {
  try {
    const QRCode = require('qrcode');
    return await QRCode.toDataURL(url, { width: 200, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
  } catch { return null; }
});

// Verificar contraseña comprometida (Have I Been Pwned, k-anonymity)
async function checkPasswordPwned(password) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const res = await net.fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' }
    });
    if (!res.ok) return 0;
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith(suffix));
    return line ? parseInt(line.split(':')[1]) : 0;
  } catch { return 0; }
}
ipcMain.handle('rave:check-pwned', async (_e, password) => checkPasswordPwned(password));
