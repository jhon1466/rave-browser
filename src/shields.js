/**
 * shields.js — Sistema de Escudos por sitio para Rave Browser
 * Inspirado en Brave Shields. Bloqueo por origen: JS, cookies, HTTPS upgrade,
 * fingerprinting y anuncios/rastreadores por sitio.
 */

const { app, ipcMain, session } = require('electron');

// Estado global del modo HTTPS-only (configurable desde ajustes de privacidad)
let _globalHttpsOnly = false;
function setGlobalHttpsOnly(val) { _globalHttpsOnly = !!val; }
const path = require('path');
const fs = require('fs');

const SHIELDS_FILE = () => path.join(app.getPath('userData'), 'shields.json');

const DEFAULT_SHIELDS = {
  enabled: true,
  adBlock: 'standard',       // 'aggressive' | 'standard' | 'allow'
  javascript: true,          // true = on, false = blocked
  fingerprinting: 'standard',// 'standard' | 'allow'
  cookies: 'cross_site',     // 'cross_site' | 'blocked' | 'allow'
  httpsUpgrade: true,        // true = upgrade http→https
  socialBlock: false,        // true = bloquear embeds de redes sociales
};

// Persistencia ---------------------------------------------------------------
let _shields = null;

function loadShields() {
  if (_shields) return _shields;
  try { _shields = JSON.parse(fs.readFileSync(SHIELDS_FILE(), 'utf8')); }
  catch { _shields = {}; }
  return _shields;
}

function saveShields(data) {
  _shields = data;
  try { fs.writeFileSync(SHIELDS_FILE(), JSON.stringify(data, null, 2)); } catch {}
}

// API de lectura/escritura ----------------------------------------------------
function getShields(origin) {
  if (!origin) return { ...DEFAULT_SHIELDS };
  const data = loadShields();
  return { ...DEFAULT_SHIELDS, ...(data[origin] || {}) };
}

function setShields(origin, key, value) {
  if (!origin) return getShields(origin);
  const data = loadShields();
  if (!data[origin]) data[origin] = {};
  data[origin][key] = value;
  saveShields(data);
  return getShields(origin);
}

// Set de orígenes con adBlock='allow' (consultado por el adblocker externo)
const shieldsAllowSet = new Set();

function _syncAllowSet() {
  shieldsAllowSet.clear();
  const data = loadShields();
  for (const [origin, cfg] of Object.entries(data)) {
    if (cfg.adBlock === 'allow' || cfg.enabled === false) shieldsAllowSet.add(origin);
  }
}

// Stats por pestaña ----------------------------------------------------------
// tabId → { adsBlocked, httpsUpgraded, jsBlocked }
const tabStats = new Map();

function getTabStats(tabId) {
  if (!tabStats.has(tabId)) tabStats.set(tabId, { adsBlocked: 0, httpsUpgraded: 0, jsBlocked: 0 });
  return tabStats.get(tabId);
}

function resetTabStats(tabId) { tabStats.delete(tabId); }

// Utilidades -----------------------------------------------------------------
const isLocal = (url) => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url);

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

// Ruta del script de preload para fingerprinting
const FP_SCRIPT_PATH = path.join(__dirname, 'fp-noise.js');

function ensureFPScript() {
  if (!fs.existsSync(FP_SCRIPT_PATH)) {
    fs.writeFileSync(FP_SCRIPT_PATH, `(function(){
  try {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const img = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < img.data.length; i += 100) img.data[i] ^= 1;
        ctx.putImageData(img, 0, 0);
      }
      return origToDataURL.apply(this, args);
    };
  } catch(e) {}
})();`);
  }
}

// Debouncing: eliminar parámetros de rastreo conocidos
const TRACKING_PARAMS = new Set([
  'utm_source','utm_medium','utm_campaign','utm_term','utm_content','utm_id',
  'fbclid','gclid','gclsrc','dclid','gbraid','wbraid','msclkid','mc_eid',
  'ref','referrer','_hsenc','_hsmi','mkt_tok','igshid','twclid',
  'yclid','srsltid','zanpid','oly_enc_id','oly_anon_id','rb_clickid','s_kwcid',
]);

function stripTrackingParams(url) {
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key)) { u.searchParams.delete(key); changed = true; }
    }
    return changed ? u.toString() : null;
  } catch { return null; }
}

function deAmpUrl(url) {
  try {
    const u = new URL(url);
    const googleAmp = u.hostname.match(/^(?:www\.)?google\.[a-z.]+$/) && u.pathname.match(/^\/amp\/s\/(.+)/);
    if (googleAmp) return 'https://' + googleAmp[1];
    if (u.hostname.startsWith('amp.')) return url.replace('://amp.', '://');
    if (u.pathname.startsWith('/amp/')) return new URL(u.pathname.replace('/amp/', '/'), u.origin).toString();
    if (u.searchParams.has('amp')) { u.searchParams.delete('amp'); return u.toString(); }
    return null;
  } catch { return null; }
}

const SOCIAL_HOSTS = /\b(connect\.facebook\.net|platform\.twitter\.com|syndication\.twitter\.com|platform\.instagram\.com|apis\.google\.com\/js\/plusone|badge\.mastodon\.social)\b/i;

// Lógica de onBeforeRequest exportable para encadenar con el adblocker ----------
// `next` es una función que llama cb({ cancel: false }) si shields no interviene.
function shieldsRequestFilter(details, cb, next) {
  const pageOrigin = originOf(details.referrer || details.url);
  const siteOrigin = details.initiator ? details.initiator : pageOrigin;
  const shields = getShields(siteOrigin);

  if (!shields.enabled) return next ? next() : cb({ cancel: false });

  // Debouncing de parámetros de rastreo (solo peticiones de documento principal)
  if (details.resourceType === 'mainFrame') {
    const clean = stripTrackingParams(details.url);
    if (clean) return cb({ redirectURL: clean });
  }

  // De-AMP: redirigir a URL canónica
  if (details.resourceType === 'mainFrame') {
    const deamped = deAmpUrl(details.url);
    if (deamped) return cb({ redirectURL: deamped });
  }

  // Bloqueo de login social / embeds de terceros
  if (shields.socialBlock && SOCIAL_HOSTS.test(details.url)) return cb({ cancel: true });

  // HTTPS upgrade (por sitio o modo global HTTPS-only)
  const doUpgrade = shields.httpsUpgrade || _globalHttpsOnly;
  if (doUpgrade && details.url.startsWith('http://') && !isLocal(details.url)) {
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
      return cb({ redirectURL: details.url.replace(/^http:\/\//i, 'https://') });
    }
  }

  // Bloqueo de JavaScript por sitio
  if (!shields.javascript && details.resourceType === 'script') {
    return cb({ cancel: true });
  }

  if (next) next(); else cb({ cancel: false });
}

// Instalación de hooks en sesión ---------------------------------------------
function installShieldsOnSession(ses) {
  if (ses.__raveShields) return;
  ses.__raveShields = true;

  // Asegurar que existe el script de fingerprinting
  ensureFPScript();

  // onBeforeRequest: bloquear JS por sitio, HTTPS upgrade
  // (Si el adblocker está activo, este handler será sobreescrito por su wrapper,
  //  que llama a shieldsRequestFilter internamente.)
  ses.webRequest.onBeforeRequest((details, cb) => shieldsRequestFilter(details, cb, null));

  // onHeadersReceived: cookie blocking
  ses.webRequest.onHeadersReceived((details, cb) => {
    const siteOrigin = details.initiator ? details.initiator : originOf(details.referrer || details.url);
    const shields = getShields(siteOrigin);

    if (!shields.enabled || shields.cookies === 'allow') {
      return cb({ responseHeaders: details.responseHeaders });
    }

    const headers = { ...details.responseHeaders };

    if (shields.cookies === 'blocked') {
      // Bloquear todas las cookies
      delete headers['set-cookie'];
      delete headers['Set-Cookie'];
    } else if (shields.cookies === 'cross_site') {
      // Bloquear solo cookies de terceros
      const reqOrigin = originOf(details.url);
      if (siteOrigin && reqOrigin && siteOrigin !== reqOrigin) {
        delete headers['set-cookie'];
        delete headers['Set-Cookie'];
      }
    }

    cb({ responseHeaders: headers });
  });
}

// Función para obtener info de shields (usada en rave:get-site-info)
function getShieldsInfo(origin) {
  return {
    ...getShields(origin),
    blockedCount: global.__raveBlockedCount || 0,
  };
}

// Handlers IPC ---------------------------------------------------------------
function registerShieldsIPC() {
  _syncAllowSet();

  ipcMain.handle('rave:get-shields', (_e, origin) => {
    return getShields(origin);
  });

  ipcMain.handle('rave:set-shields', (_e, { origin, key, value }) => {
    const result = setShields(origin, key, value);
    _syncAllowSet();
    return result;
  });

  ipcMain.handle('rave:get-shields-all', () => {
    return loadShields();
  });

  ipcMain.handle('rave:reset-shields', (_e, origin) => {
    const data = loadShields();
    delete data[origin];
    saveShields(data);
    _syncAllowSet();
    return { ...DEFAULT_SHIELDS };
  });
}

module.exports = {
  DEFAULT_SHIELDS,
  loadShields,
  saveShields,
  getShields,
  setShields,
  getShieldsInfo,
  registerShieldsIPC,
  installShieldsOnSession,
  shieldsAllowSet,
  shieldsRequestFilter,
  setGlobalHttpsOnly,
};
