// ===== Iconos =====
document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = ICONS[el.dataset.icon] || ''; });

// ===== Modo de la ventana =====
const params = new URLSearchParams(location.search);
const INCOGNITO = params.get('incognito') === '1';
if (INCOGNITO) document.body.classList.add('incognito');

// ===== Persistencia =====
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('rave.' + k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem('rave.' + k, JSON.stringify(v)); }
};

// Cifrado XOR básico para contraseñas (ofuscación en localStorage)
const xorKey = 'rave-browser-key-2024';
function xorEncrypt(str) {
  return btoa(Array.from(str).map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ xorKey.charCodeAt(i % xorKey.length))).join(''));
}
function xorDecrypt(encoded) {
  try {
    const raw = atob(encoded);
    return Array.from(raw).map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ xorKey.charCodeAt(i % xorKey.length))).join('');
  } catch { return ''; }
}
// Cifrado seguro con safeStorage (cuenta del SO). Compatibilidad con lo antiguo.
const secEnc = (text) => window.rave.encrypt(text);
const secDec = (value) => (typeof value === 'string' && (value.startsWith('enc:') || value.startsWith('b64:')))
  ? window.rave.decrypt(value) : Promise.resolve(xorDecrypt(value));

const ENGINES = {
  ddg:    { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  google: { name: 'Google',     url: 'https://www.google.com/search?q=' },
  bing:   { name: 'Bing',       url: 'https://www.bing.com/search?q=' },
  brave:  { name: 'Brave',      url: 'https://search.brave.com/search?q=' },
  ecosia: { name: 'Ecosia',     url: 'https://www.ecosia.org/search?q=' },
};
let settings = store.get('settings', {
  engine: 'ddg', homepage: '', theme: 'system',
  savePasswords: true, showBookmarksBar: false, animations: true, readerFont: 'serif',
  // Privacidad
  trackingLevel: 'standard', dnt: false, httpsOnly: false, clearOnExit: false,
  // Rendimiento — minutos de inactividad para poner pestañas en reposo (0 = nunca)
  sleepTimeout: 10,
  // Escudos — valores predeterminados para sitios nuevos
  shieldsEnabled: true, shieldsAdBlock: 'standard', shieldsJS: true,
  shieldsFP: true, shieldsCookies: 'cross_site', shieldsHTTPS: true,
});
// Compatibilidad con ajustes guardados antes de existir privacidad.
if (settings.trackingLevel === undefined) settings.trackingLevel = 'standard';
if (settings.sleepTimeout === undefined) settings.sleepTimeout = 10;
let bookmarks = store.get('bookmarks', []);
let history = [];
if (!INCOGNITO) window.rave.historySearch('').then(h => { history = h || []; }).catch(() => {});
let downloads = INCOGNITO ? [] : store.get('downloads', []);
let passwords = store.get('passwords', []); // [{domain, username, password(encrypted), ts}]
let notes = store.get('notes', '');
let sessions = store.get('sessions', []); // [{name, urls, ts}]
const closedTabs = [];

// Motor activo: se sincroniza con el backend al arrancar y al cambiar en ajustes
let _activeEngineUrl = null;
const enginePrefix = () => {
  if (_activeEngineUrl) return _activeEngineUrl.replace('%s', '');
  return (ENGINES[settings.engine] || ENGINES.ddg).url;
};
const buildSearchUrl = (query) => {
  if (_activeEngineUrl) return _activeEngineUrl.replace('%s', encodeURIComponent(query));
  return (ENGINES[settings.engine] || ENGINES.ddg).url + encodeURIComponent(query);
};
// Sincronizar motor activo desde el backend
if (window.rave.getEngines) {
  window.rave.getEngines().then(engines => {
    const def = engines && engines.find(e => e.default);
    if (def) _activeEngineUrl = def.url;
  }).catch(() => {});
}
const NEWTAB_BASE = new URL('newtab.html', location.href).href;

const DEFAULT_SITES = [
  { title: 'YouTube', url: 'https://www.youtube.com' }, { title: 'Wikipedia', url: 'https://www.wikipedia.org' },
  { title: 'GitHub', url: 'https://github.com' }, { title: 'Reddit', url: 'https://www.reddit.com' },
  { title: 'X', url: 'https://x.com' }, { title: 'Amazon', url: 'https://www.amazon.com' },
  { title: 'Gmail', url: 'https://mail.google.com' }, { title: 'Maps', url: 'https://maps.google.com' }
];
function topSites() {
  const byHost = new Map();
  for (const h of history) {
    try {
      const host = new URL(h.url).hostname.replace(/^www\./, '');
      const e = byHost.get(host) || { count: 0, title: '', url: h.url };
      e.count++; e.title = h.title || e.title; byHost.set(host, e);
    } catch {}
  }
  const ranked = [...byHost.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8)
    .map(([host, e]) => ({ title: (e.title || host).split(' - ')[0].slice(0, 22), url: e.url, host }));
  const seen = new Set(ranked.map((r) => r.host));
  for (const d of DEFAULT_SITES) {
    if (ranked.length >= 8) break;
    const host = new URL(d.url).hostname.replace(/^www\./, '');
    if (!seen.has(host)) { ranked.push({ ...d, host }); seen.add(host); }
  }
  return ranked;
}
const newTabURL = () => NEWTAB_BASE + '?engine=' + encodeURIComponent(enginePrefix()) +
  '&theme=' + encodeURIComponent(settings.theme || 'system') +
  '&sites=' + encodeURIComponent(JSON.stringify(INCOGNITO ? [] : topSites()));
const homeURL = () => (settings.homepage?.trim() ? settings.homepage.trim() : newTabURL());
const isInternal = (url) => !url || url.startsWith(NEWTAB_BASE);

// ===== Estado de pestañas =====
const tabs = new Map();   // id -> { el, favEl, spinEl, titleEl, title, url, zoom, back, fwd }
let activeId = null;
let draggedTabId = null;

const $ = (id) => document.getElementById(id);
const $tabs = $('tabs'), $address = $('address'), $back = $('back'), $forward = $('forward');
const $star = $('star'), $security = $('security'), $progress = $('progress');

function toURL(input) {
  const t = input.trim();
  if (!t) return homeURL();
  if (/^[a-z]+:\/\//i.test(t)) return t;
  if (/^[^\s]+\.[^\s]+$/.test(t) && !t.includes(' ')) return 'https://' + t;
  return buildSearchUrl(t);
}
const activeTab = () => tabs.get(activeId);

// Tamaño real de la ventana
let winW = window.innerWidth, winH = window.innerHeight;
window.rave.onViewSize(({ w, h }) => { winW = w; winH = h; });

// ===== Comandos hacia el proceso principal =====
function createTab(url) { return window.rave.tabCreate(url || newTabURL()); }
function act(action, arg) { if (activeId != null) window.rave.tabAction(activeId, action, arg); }

// ===== Eventos desde el proceso principal =====
window.rave.onTabOpened(({ id, url }) => {
  const el = document.createElement('div');
  el.className = 'tab';
  el.draggable = true;
  el.dataset.id = id;
  el.innerHTML = `<img class="favicon hidden" /><div class="spinner hidden"></div>` +
    `<span class="title">Nueva pestaña</span>` +
    `<button class="tab-audio hidden" title="Silenciar">${ICONS.volume}</button>` +
    `<span class="close" title="Cerrar">${ICONS.close}</span>`;
  $tabs.appendChild(el);
  setTimeout(() => { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); updateTabsOverflow(); }, 50);
  el.addEventListener('click', (e) => { if (!e.target.closest('.close') && !e.target.closest('.tab-audio')) window.rave.tabSelect(id); });
  el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); window.rave.tabClose(id); } });
  el.querySelector('.close').addEventListener('click', (e) => { e.stopPropagation(); window.rave.tabClose(id); });
  el.querySelector('.tab-audio').addEventListener('click', (e) => { e.stopPropagation(); toggleMute(id); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showTabMenu(id, e.clientX, e.clientY); });
  el.addEventListener('mouseenter', () => showTabPreview(id, el));
  el.addEventListener('mouseleave', hideTabPreview);
  el.addEventListener('click', hideTabPreview);
  el.addEventListener('dragstart', () => {
    el.classList.add('dragging');
    draggedTabId = id;
    if (tabs.size > 1) {
      $('drag-split-overlay').classList.remove('hidden');
      window.rave.setOverlay(true);
    }
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    $('drag-split-overlay').classList.add('hidden');
    $('drop-left').classList.remove('hover');
    $('drop-right').classList.remove('hover');
    window.rave.setOverlay(false);
    syncTabOrder();
  });
  tabs.set(id, {
    el, title: 'Nueva pestaña', url, zoom: 1, back: false, fwd: false,
    favEl: el.querySelector('.favicon'), spinEl: el.querySelector('.spinner'), titleEl: el.querySelector('.title'),
    audioEl: el.querySelector('.tab-audio'),
    isSplit: false, activeSide: 'primary', pinned: false, muted: false, audible: false
  });
  saveSession();
});

// ===== Audio / silenciar pestaña =====
function toggleMute(id) {
  const t = tabs.get(id); if (!t) return;
  t.muted = !t.muted;
  window.rave.tabAction(id, 'mute', t.muted);
  updateAudio(t);
}
function updateAudio(t) {
  if (!t.audioEl) return;
  const show = t.audible || t.muted;
  t.audioEl.classList.toggle('hidden', !show);
  t.audioEl.innerHTML = t.muted ? ICONS.volumeOff : ICONS.volume;
  t.audioEl.title = t.muted ? 'Activar sonido' : 'Silenciar';
}

// ===== Fijar pestaña =====
function togglePin(id) {
  const t = tabs.get(id); if (!t) return;
  t.pinned = !t.pinned;
  t.el.classList.toggle('pinned', t.pinned);
  reorderPinned();
  saveSession();
}
function reorderPinned() {
  [...$tabs.children]
    .sort((a, b) => (tabs.get(+a.dataset.id)?.pinned ? 0 : 1) - (tabs.get(+b.dataset.id)?.pinned ? 0 : 1))
    .forEach((e) => $tabs.appendChild(e));
}

// ===== Menú contextual de pestaña =====
function showTabMenu(id, x, y) {
  const t = tabs.get(id); if (!t) return;
  const order = [...$tabs.querySelectorAll('.tab')].map((e) => +e.dataset.id);
  const rightCount = order.length - order.indexOf(id) - 1;
  showContextMenu([
    { label: 'Nueva pestaña', action: () => createTab() },
    { label: 'Recargar', action: () => window.rave.tabAction(id, 'reload') },
    { label: 'Duplicar', action: () => createTab(t.url) },
    'sep',
    { label: t.pinned ? 'Desfijar pestaña' : 'Fijar pestaña', action: () => togglePin(id) },
    { label: t.muted ? 'Activar sonido' : 'Silenciar pestaña', action: () => toggleMute(id) },
    { label: 'Poner en reposo', disabled: t.suspended || isInternal(t.url) || tabs.size < 2, action: () => window.rave.tabAction(id, 'suspend') },
    'sep',
    { label: 'Cerrar', action: () => window.rave.tabClose(id) },
    { label: 'Cerrar las demás', disabled: tabs.size < 2, action: () => closeOtherTabs(id) },
    { label: 'Cerrar las de la derecha', disabled: rightCount < 1, action: () => closeTabsToRight(id) },
  ], x, y);
}
function closeOtherTabs(keepId) {
  for (const tid of [...tabs.keys()]) if (tid !== keepId && !tabs.get(tid)?.pinned) window.rave.tabClose(tid);
}
function closeTabsToRight(id) {
  const order = [...$tabs.querySelectorAll('.tab')].map((e) => +e.dataset.id);
  const idx = order.indexOf(id);
  order.slice(idx + 1).forEach((tid) => { if (!tabs.get(tid)?.pinned) window.rave.tabClose(tid); });
}

window.rave.onTabActivated(({ id }) => {
  activeId = id;
  for (const [tid, t] of tabs) t.el.classList.toggle('active', tid === id);
  tabs.get(id)?.el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateChrome();
});

window.rave.onTabClosed(({ id }) => {
  const t = tabs.get(id);
  if (!t) return;
  if (!isInternal(t.url)) closedTabs.push(t.url);
  const order = [...$tabs.querySelectorAll('.tab')].map((e) => +e.dataset.id);
  const idx = order.indexOf(id);
  animateTabClose(t.el);
  tabs.delete(id);
  setTimeout(updateTabsOverflow, 250);
  if (activeId === id) {
    const next = order[idx + 1] ?? order[idx - 1];
    if (next != null && tabs.has(next)) window.rave.tabSelect(next);
    else createTab();
  }
  saveSession();
});

// Colapsa la pestaña con una transición antes de quitarla del DOM.
function animateTabClose(el) {
  if (document.documentElement.classList.contains('no-anim')) { el.remove(); return; }
  el.style.maxWidth = el.offsetWidth + 'px';
  el.classList.add('closing');
  requestAnimationFrame(() => { el.style.maxWidth = '0px'; el.style.opacity = '0'; });
  el.addEventListener('transitionend', () => el.remove(), { once: true });
  setTimeout(() => el.isConnected && el.remove(), 320);   // respaldo
}

let _zoomToast = null, _zoomToastT = null;
function showZoomToast(pct) {
  if (!_zoomToast) {
    _zoomToast = document.createElement('div');
    _zoomToast.id = 'zoom-toast';
    document.body.appendChild(_zoomToast);
  }
  _zoomToast.textContent = pct + '%';
  _zoomToast.classList.add('visible');
  clearTimeout(_zoomToastT);
  _zoomToastT = setTimeout(() => { _zoomToast && _zoomToast.classList.remove('visible'); }, 1200);
}

window.rave.onTabUpdated(({ id, title, url, favicon, loading, canGoBack, canGoForward, muted, audible, suspended, zoom }) => {
  const t = tabs.get(id);
  if (!t) return;
  if (zoom !== undefined && id === activeId) { t.zoom = zoom; $('zoom-level').textContent = Math.round(zoom * 100) + '%'; showZoomToast(Math.round(zoom * 100)); }
  if (muted !== undefined) { t.muted = muted; updateAudio(t); }
  if (audible !== undefined) { t.audible = audible; updateAudio(t); }
  if (suspended !== undefined) { t.suspended = suspended; t.el.classList.toggle('suspended', suspended); }
  if (title !== undefined) { t.title = title; t.titleEl.textContent = isInternal(t.url) ? 'Nueva pestaña' : (title || 'Sin título'); recordHistory(t); }
  if (url !== undefined) {
    t.url = url;
    // Mantener las URLs de cada lado del split actualizadas para la sesión
    if (t.isSplit) {
      if (t.activeSide === 'secondary') t.splitUrl = url;
      else t.primaryUrl = url;
    }
    if (isInternal(url)) { t.favEl.classList.add('hidden'); t.favUrl = null; }
    recordHistory(t); saveSession();
  }
  if (favicon !== undefined && favicon) { t.favUrl = favicon; t.favEl.src = favicon; if (!loading) t.favEl.classList.remove('hidden'); }
  if (loading !== undefined) {
    t.spinEl.classList.toggle('hidden', !loading);
    t.el.classList.toggle('loading', !!loading);
    if (loading) t.favEl.classList.add('hidden'); else if (t.favUrl) t.favEl.classList.remove('hidden');
    if (id === activeId) loading ? setProgress(30) : finishProgress();
    // Restaurar split de sesión cuando la pestaña termina de cargar
    if (loading === false && window._pendingSplit && window._pendingSplit.has(id)) {
      const sp = window._pendingSplit.get(id);
      window._pendingSplit.delete(id);
      window.rave.tabSplitToggle(id, sp.splitUrl, sp.splitRatio, sp.activeSide);
    }
  }
  if (canGoBack !== undefined) t.back = canGoBack;
  if (canGoForward !== undefined) t.fwd = canGoForward;
  if (id === activeId) updateChrome();
});

window.rave.onTabFound(({ id, activeMatchOrdinal, matches }) => {
  if (id === activeId && activeMatchOrdinal !== undefined) $('find-count').textContent = `${activeMatchOrdinal}/${matches}`;
});

// ===== Detección de formularios de contraseña =====
let pendingPasswordUrl = null;
window.rave.onPasswordFormDetected(({ url }) => {
  if (!settings.savePasswords || INCOGNITO) return;
  pendingPasswordUrl = url;
  // No mostramos la barra automáticamente — se activa al navegar a otra URL
});

// ===== Chrome (barra) =====
function updateChrome() {
  const t = activeTab();
  if (!t) { $address.value = ''; return; }
  if (document.activeElement !== $address) $address.value = isInternal(t.url) ? '' : t.url;
  $back.disabled = !t.back; $forward.disabled = !t.fwd;
  const saved = bookmarks.some((b) => b.url === t.url);
  $star.classList.toggle('saved', saved);
  $star.innerHTML = saved ? ICONS.starFill : ICONS.star;
  setSecurity(t.url);
  $('zoom-level').textContent = Math.round(t.zoom * 100) + '%';
  // Mostrar botón lector solo en páginas no internas; resetear estado active al cambiar pestaña
  $('reader-btn').style.display = isInternal(t.url) ? 'none' : '';
  $('reader-btn').classList.remove('active');

  updateSplitIndicator();
  updateSplitButton();
}
function setSecurity(url) {
  if (isInternal(url) || !url) { $security.innerHTML = ''; $security.className = ''; return; }
  if (url.startsWith('https://')) { $security.innerHTML = ICONS.lock; $security.className = 'secure'; $security.title = 'Información del sitio'; }
  else { $security.innerHTML = ICONS.globe; $security.className = ''; $security.title = 'Información del sitio'; }
}

// ===== Panel de info de seguridad =====
let $sitePanel = null;
function closeSitePanel() {
  if ($sitePanel) { $sitePanel.remove(); $sitePanel = null; toastCount = Math.max(0, toastCount - 1); updateOverlay(); }
}
const PERM_META = {
  camera:          { icon: 'camera',  label: 'Cámara' },
  microphone:      { icon: 'volume',  label: 'Micrófono' },
  geolocation:     { icon: 'globe',   label: 'Ubicación' },
  notifications:   { icon: 'note',    label: 'Notificaciones' },
  'clipboard-read':{ icon: 'copy',    label: 'Portapapeles' },
  'display-capture':{ icon: 'layers', label: 'Compartir pantalla' },
  midi:            { icon: 'layers',  label: 'MIDI' },
};

function permSelect(origin, perm, current) {
  return `<select class="sp-perm-sel" data-perm="${perm}">
    <option value="default" ${current === undefined ? 'selected' : ''}>Predeterminado</option>
    <option value="allow"   ${current === 'allow'   ? 'selected' : ''}>Permitir</option>
    <option value="block"   ${current === 'block'   ? 'selected' : ''}>Bloquear</option>
  </select>`;
}

$security.addEventListener('click', async (e) => {
  e.stopPropagation();
  if ($sitePanel) { closeSitePanel(); return; }
  const t = tabs.get(activeId); if (!t) return;
  const isSecure = t.url?.startsWith('https://');
  const info = await window.rave.getSiteInfo();
  let hostname = '';
  try { hostname = new URL(t.url).hostname; } catch { }
  const perms = info?.perms || {};
  const origin = info?.origin || '';
  const shields = info?.shields || { enabled: true, adBlock: 'standard', javascript: true, fingerprinting: 'standard', cookies: 'cross_site', httpsUpgrade: true };

  // Filas de permisos guardados + permisos estándar
  const permEntries = Object.entries(PERM_META);
  const permRows = permEntries.map(([key, meta]) => {
    const val = perms[key];
    const ic = ICONS[meta.icon] || ICONS.shield;
    const badge = val === 'allow' ? `<span class="sp-perm-badge allow">Permitido</span>`
                : val === 'block' ? `<span class="sp-perm-badge block">Bloqueado</span>` : '';
    return `<div class="sp-perm-row" data-perm="${key}">
      <span class="sp-row-ic">${ic}</span>
      <span class="sp-perm-label">${meta.label}</span>
      <div class="sp-perm-right">${badge}${permSelect(origin, key, val)}</div>
    </div>`;
  }).join('');

  const shieldsEnabled = shields.enabled !== false;
  const blockedCount = info?.blockedCount ?? 0;

  $sitePanel = document.createElement('div');
  $sitePanel.id = 'site-panel';
  $sitePanel.innerHTML = `
    <!-- SECCIÓN 1: Cabecera de Escudos -->
    <div class="sp-shields-header ${shieldsEnabled ? 'shields-on' : 'shields-off'}">
      <div class="sp-shields-site">
        <img class="sp-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32" width="20" height="20" onerror="this.style.display='none'">
        <span class="sp-host-shields"></span>
      </div>
      <div class="sp-shields-toggle-row">
        <div class="sp-shields-status">
          <div class="sp-shields-icon">${shieldsEnabled ? ICONS.shield_on : ICONS.shield_off}</div>
          <div>
            <div class="sp-shields-label">Escudos</div>
            <div class="sp-shields-sublabel">${shieldsEnabled ? 'Activados para este sitio' : 'Desactivados para este sitio'}</div>
          </div>
        </div>
        <label class="sp-toggle-switch">
          <input type="checkbox" id="sp-shield-main" ${shieldsEnabled ? 'checked' : ''}>
          <span class="sp-toggle-track"></span>
        </label>
      </div>
      <div class="sp-shields-count">${blockedCount}</div>
      <div class="sp-shields-count-label">rastreadores y anuncios bloqueados</div>
    </div>

    <!-- SECCIÓN 2: Controles avanzados -->
    <div class="sp-advanced ${shieldsEnabled ? '' : 'sp-disabled'}">
      <button class="sp-advanced-toggle">
        <span>Controles avanzados</span>
        <span class="sp-advanced-chevron">${ICONS.forward}</span>
      </button>
      <div class="sp-advanced-body hidden">
        <div class="sp-control-row">
          <span class="sp-ctrl-ic">${ICONS.shield}</span>
          <span class="sp-ctrl-label">Rastreadores y anuncios</span>
          <select class="sp-ctrl-sel" id="sp-adblock">
            <option value="aggressive" ${shields.adBlock === 'aggressive' ? 'selected' : ''}>Agresivo</option>
            <option value="standard"   ${shields.adBlock === 'standard'   ? 'selected' : ''}>Estándar</option>
            <option value="allow"      ${shields.adBlock === 'allow'      ? 'selected' : ''}>Permitir</option>
          </select>
        </div>
        <div class="sp-control-row">
          <span class="sp-ctrl-ic">${ICONS.js}</span>
          <span class="sp-ctrl-label">JavaScript</span>
          <label class="sp-toggle-switch">
            <input type="checkbox" id="sp-js" ${shields.javascript !== false ? 'checked' : ''}>
            <span class="sp-toggle-track"></span>
          </label>
        </div>
        <div class="sp-control-row">
          <span class="sp-ctrl-ic">${ICONS.fingerprint}</span>
          <span class="sp-ctrl-label">Privacidad de huella digital</span>
          <label class="sp-toggle-switch">
            <input type="checkbox" id="sp-fp" ${shields.fingerprinting === 'standard' ? 'checked' : ''}>
            <span class="sp-toggle-track"></span>
          </label>
        </div>
        <div class="sp-control-row">
          <span class="sp-ctrl-ic">${ICONS.cookie}</span>
          <span class="sp-ctrl-label">Cookies</span>
          <select class="sp-ctrl-sel" id="sp-cookies">
            <option value="blocked"    ${shields.cookies === 'blocked'    ? 'selected' : ''}>Bloquear todo</option>
            <option value="cross_site" ${shields.cookies === 'cross_site' ? 'selected' : ''}>Solo terceros</option>
            <option value="allow"      ${shields.cookies === 'allow'      ? 'selected' : ''}>Permitir</option>
          </select>
        </div>
        <div class="sp-control-row">
          <span class="sp-ctrl-ic">${ICONS.https}</span>
          <span class="sp-ctrl-label">Actualizar a HTTPS</span>
          <label class="sp-toggle-switch">
            <input type="checkbox" id="sp-https" ${shields.httpsUpgrade !== false ? 'checked' : ''}>
            <span class="sp-toggle-track"></span>
          </label>
        </div>
        <div class="sp-control-row">
          <span class="sp-ctrl-ic">${ICONS.globe}</span>
          <span class="sp-ctrl-label">Bloquear login social</span>
          <label class="sp-toggle-switch">
            <input type="checkbox" id="sp-social" ${shields.socialBlock ? 'checked' : ''}>
            <span class="sp-toggle-track"></span>
          </label>
        </div>
      </div>
    </div>

    <!-- SECCIÓN 3: Conexión -->
    <div class="sp-row ${isSecure ? 'secure' : 'insecure'}">
      <span class="sp-row-ic">${isSecure ? ICONS.lock : ICONS.globe}</span>
      <div class="sp-row-body">
        <div class="sp-row-title">${isSecure ? 'La conexión es segura' : 'Conexión no segura'}</div>
        <div class="sp-row-sub">${isSecure ? 'La información que envías es privada' : 'No uses contraseñas ni datos sensibles'}</div>
      </div>
    </div>
    ${info?.cert ? `
    <div class="sp-row sp-cert-row">
      <span class="sp-row-ic">${ICONS.note}</span>
      <div class="sp-row-body">
        <div class="sp-row-title">Certificado</div>
        <div class="sp-row-sub">${info.cert.issuer || 'Desconocido'}</div>
      </div>
      <span class="sp-row-arrow">${ICONS.forward}</span>
    </div>
    <div id="sp-cert-detail" class="sp-cert-detail hidden">
      <div class="sp-detail-row"><span>Emisor</span><span>${info.cert.issuer || '—'}</span></div>
      <div class="sp-detail-row"><span>Sujeto</span><span>${info.cert.subject || '—'}</span></div>
      ${info.cert.validExpiry ? `<div class="sp-detail-row"><span>Válido hasta</span><span>${new Date(info.cert.validExpiry * 1000).toLocaleDateString()}</span></div>` : ''}
    </div>` : ''}

    <!-- SECCIÓN 4: Permisos -->
    <div class="sp-advanced sp-perms-section">
      <button class="sp-advanced-toggle">
        <span>Permisos del sitio</span>
        <span class="sp-advanced-chevron">${ICONS.forward}</span>
      </button>
      <div class="sp-advanced-body sp-perms hidden">${permRows}</div>
    </div>

    <!-- SECCIÓN 5: Datos -->
    <div class="sp-row">
      <span class="sp-row-ic">${ICONS.cookie}</span>
      <div class="sp-row-body">
        <div class="sp-row-title">Cookies y datos del sitio</div>
        <div class="sp-row-sub">${info?.cookieCount ?? 0} cookie${(info?.cookieCount ?? 0) !== 1 ? 's' : ''} almacenadas</div>
      </div>
    </div>
    <div class="sp-actions">
      <button class="btn ghost sp-cookies-btn">Ver cookies</button>
      <button class="btn ghost sp-clear-btn">Borrar datos</button>
      <button class="btn ghost sp-shields-reset-btn">Resetear escudos</button>
    </div>
    <button class="icon-btn sp-close sp-close-float">${ICONS.close}</button>`;

  $sitePanel.querySelector('.sp-host-shields').textContent = hostname;
  $sitePanel.querySelectorAll('.sp-close, .sp-close-float').forEach(b => b.addEventListener('click', closeSitePanel));

  const certRow = $sitePanel.querySelector('.sp-cert-row');
  if (certRow) certRow.addEventListener('click', () => $sitePanel.querySelector('#sp-cert-detail').classList.toggle('hidden'));

  // Toggle principal de escudos
  $sitePanel.querySelector('#sp-shield-main').addEventListener('change', async (ev) => {
    const on = ev.target.checked;
    await window.rave.setShields(origin, 'enabled', on);
    const hdr = $sitePanel.querySelector('.sp-shields-header');
    hdr.className = `sp-shields-header ${on ? 'shields-on' : 'shields-off'}`;
    hdr.querySelector('.sp-shields-icon').innerHTML = on ? ICONS.shield_on : ICONS.shield_off;
    hdr.querySelector('.sp-shields-sublabel').textContent = on ? 'Activados para este sitio' : 'Desactivados para este sitio';
    $sitePanel.querySelector('.sp-advanced').classList.toggle('sp-disabled', !on);
  });

  // Expandir/colapsar secciones acordeón (controles avanzados + permisos)
  $sitePanel.querySelectorAll('.sp-advanced-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const body = btn.nextElementSibling;
      const chev = btn.querySelector('.sp-advanced-chevron');
      body.classList.toggle('hidden');
      chev.classList.toggle('rotated');
    });
  });

  // Bloqueo de anuncios
  $sitePanel.querySelector('#sp-adblock').addEventListener('change', async (ev) => {
    await window.rave.setShields(origin, 'adBlock', ev.target.value);
  });

  // JavaScript
  $sitePanel.querySelector('#sp-js').addEventListener('change', async (ev) => {
    await window.rave.setShields(origin, 'javascript', ev.target.checked);
  });

  // Fingerprinting
  $sitePanel.querySelector('#sp-fp').addEventListener('change', async (ev) => {
    await window.rave.setShields(origin, 'fingerprinting', ev.target.checked ? 'standard' : 'allow');
  });

  // Cookies
  $sitePanel.querySelector('#sp-cookies').addEventListener('change', async (ev) => {
    await window.rave.setShields(origin, 'cookies', ev.target.value);
  });

  // HTTPS upgrade
  $sitePanel.querySelector('#sp-https').addEventListener('change', async (ev) => {
    await window.rave.setShields(origin, 'httpsUpgrade', ev.target.checked);
  });

  // Bloqueo de login social
  $sitePanel.querySelector('#sp-social').addEventListener('change', async (ev) => {
    await window.rave.setShields(origin, 'socialBlock', ev.target.checked);
  });

  // Cambio de permiso desde el select
  $sitePanel.querySelectorAll('.sp-perm-sel').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const perm = sel.dataset.perm;
      await window.rave.setSitePerm(origin, perm, sel.value);
      const badge = sel.closest('.sp-perm-row').querySelector('.sp-perm-badge');
      if (badge) badge.remove();
      if (sel.value !== 'default') {
        const b = document.createElement('span');
        b.className = `sp-perm-badge ${sel.value}`;
        b.textContent = sel.value === 'allow' ? 'Permitido' : 'Bloqueado';
        sel.closest('.sp-perm-right').prepend(b);
      }
    });
  });

  $sitePanel.querySelector('.sp-cookies-btn').addEventListener('click', () => { closeSitePanel(); openPanel('cookies'); });
  $sitePanel.querySelector('.sp-clear-btn').addEventListener('click', async () => {
    await window.rave.clearSiteCookies(t.url);
    await window.rave.deleteSitePerms(origin);
    toast({ name: hostname }, 'Datos y permisos del sitio eliminados');
    closeSitePanel();
  });
  $sitePanel.querySelector('.sp-shields-reset-btn').addEventListener('click', async () => {
    await window.rave.resetShields(origin);
    toast({ name: hostname }, 'Escudos restaurados a valores predeterminados');
    closeSitePanel();
  });

  $('address-wrap').appendChild($sitePanel);
  toastCount++; updateOverlay();
});
document.addEventListener('click', (e) => {
  if ($sitePanel && !$sitePanel.contains(e.target) && e.target !== $security) closeSitePanel();
});

// ===== Progreso =====
// Barra de progreso con avance progresivo (trickle): sube sola hacia ~90%
// mientras carga, dando sensación de fluidez, y se completa al terminar.
let progTimer = null, trickleTimer = null, progValue = 0;
function setProgress(p) {
  clearTimeout(progTimer);
  $progress.classList.add('loading');
  progValue = p;
  $progress.style.width = p + '%';
  clearInterval(trickleTimer);
  trickleTimer = setInterval(() => {
    if (progValue >= 90) return;
    progValue += (90 - progValue) * 0.12;     // se acerca a 90% con desaceleración
    $progress.style.width = progValue.toFixed(1) + '%';
  }, 220);
}
function finishProgress() {
  clearInterval(trickleTimer);
  $progress.style.width = '100%';
  progTimer = setTimeout(() => {
    $progress.classList.remove('loading');
    $progress.style.width = '0%'; progValue = 0;
  }, 320);
}

// ===== Historial / sesión =====
function recordHistory(t) {
  if (INCOGNITO || isInternal(t.url)) return;
  const last = history[0];
  if (last && last.url === t.url) last.title = t.title;
  else history.unshift({ title: t.title, url: t.url, ts: Date.now() });
  if (history.length > 2000) history.length = 2000;
}
// Guardado de sesión con debounce: evita escribir en localStorage en cada
// navegación/título (antes se hacía decenas de veces seguidas).
let _saveSessionT = null;
function saveSession() {
  clearTimeout(_saveSessionT);
  _saveSessionT = setTimeout(saveSessionNow, 400);
}
function saveSessionNow() {
  if (INCOGNITO) return;
  const order = [...$tabs.querySelectorAll('.tab')].map((e) => tabs.get(+e.dataset.id)).filter(Boolean);
  const sessionData = order.map((t) => {
    const isSplit = !!t.isSplit;
    if (!isSplit && isInternal(t.url)) {
      return null;
    }
    const primaryUrl = (isSplit ? t.primaryUrl : null) || t.url || '';
    const splitUrl = (isSplit ? t.splitUrl : null) || '';
    // No guardar si ambas URLs están vacías o son internas
    if (isSplit && (!splitUrl || isInternal(splitUrl))) {
      // Split incompleto — guardar solo la primaria como pestaña normal
      return primaryUrl && !isInternal(primaryUrl) ? { url: primaryUrl, isSplit: false, pinned: !!t.pinned } : null;
    }
    return {
      url: primaryUrl,
      isSplit: isSplit,
      splitUrl: splitUrl,
      splitRatio: t.splitRatio || 0.5,
      activeSide: t.activeSide || 'primary',
      pinned: !!t.pinned
    };
  }).filter(Boolean);
  store.set('session', sessionData);
}

// ===== Marcadores =====
function toggleBookmark() {
  const t = activeTab();
  if (!t || isInternal(t.url)) return;
  const i = bookmarks.findIndex((b) => b.url === t.url);
  if (i >= 0) bookmarks.splice(i, 1); else bookmarks.unshift({ title: t.title || t.url, url: t.url });
  store.set('bookmarks', bookmarks); renderBookmarksBar(); updateChrome();
}
function renderBookmarksBar() {
  const bar = $('bookmarks-bar'); bar.innerHTML = '';
  if (!settings.showBookmarksBar) { bar.style.display = 'none'; measureLayout(); return; }
  bar.style.display = '';
  for (const b of bookmarks) {
    const el = document.createElement('div');
    el.className = 'bm'; el.title = b.url;
    el.innerHTML = `${ICONS.star}<span class="bm-title"></span>`;
    el.querySelector('.bm-title').textContent = b.title;
    el.addEventListener('click', () => act('navigate', b.url));
    bar.appendChild(el);
  }
  measureLayout();
}

// ===== Barra de navegación =====
$back.addEventListener('click', () => act('back'));
$forward.addEventListener('click', () => act('forward'));
$('reload').addEventListener('click', () => act('reload'));
$('home').addEventListener('click', () => act('navigate', homeURL()));
$star.addEventListener('click', toggleBookmark);
$('new-tab').addEventListener('click', () => createTab());

// ===== Scroll de pestañas =====
const $tabsClip = $('tabs-clip');
const $tabbar = $tabsClip.closest('#tabbar') || $tabsClip.parentElement;

function updateTabsOverflow() {
  const overflow = $tabs.scrollWidth > $tabsClip.clientWidth + 2;
  $tabbar.classList.toggle('tabs-overflow', overflow);
}

$('tabs-scroll-left').addEventListener('click', () => {
  $tabs.scrollBy({ left: -200, behavior: 'smooth' });
});
$('tabs-scroll-right').addEventListener('click', () => {
  $tabs.scrollBy({ left: 200, behavior: 'smooth' });
});

$tabs.addEventListener('wheel', (e) => {
  if (e.deltaY !== 0) {
    e.preventDefault();
    $tabs.scrollBy({ left: e.deltaY * 1.5, behavior: 'smooth' });
  }
}, { passive: false });

new ResizeObserver(updateTabsOverflow).observe($tabsClip);

// ===== Modo lector =====
$('reader-btn').addEventListener('click', async () => {
  const res = await window.rave.injectReader();
  if (!res?.ok) { toast({ name: 'Modo lector' }, 'No disponible en esta página'); return; }
  $('reader-btn').classList.toggle('active', !!res.active);
  toast({ name: res.active ? 'Modo lector activado' : 'Modo lector desactivado' },
        res.active ? 'Vista simplificada de lectura' : 'Página restaurada');
});

// ===== Sugerencias =====
const $suggest = $('suggest');
let sgItems = [], sgIndex = -1;
function buildSuggestions(q) {
  const query = q.trim().toLowerCase(); const out = [];
  if (query) out.push({ type: 'search', text: `Buscar "${q.trim()}"`, url: buildSearchUrl(q.trim()) });
  if (query) {
    const seen = new Set();
    for (const it of [...bookmarks.map((b) => ({ ...b, type: 'bm' })), ...history.map((h) => ({ ...h, type: 'hist' }))]) {
      if (out.length >= 8) break;
      if (seen.has(it.url)) continue;
      if (it.url.toLowerCase().includes(query) || (it.title || '').toLowerCase().includes(query)) {
        seen.add(it.url); out.push({ type: it.type, text: it.title || it.url, url: it.url });
      }
    }
  }
  return out;
}
function showSuggestions() {
  sgItems = buildSuggestions($address.value); sgIndex = -1;
  if (!sgItems.length || !$address.value.trim()) return hideSuggestions();
  $suggest.innerHTML = '';
  sgItems.forEach((it) => {
    const ic = it.type === 'search' ? ICONS.search : it.type === 'bm' ? ICONS.star : ICONS.clock;
    const row = document.createElement('div'); row.className = 'sg';
    row.innerHTML = `<span class="sg-ic">${ic}</span><span class="sg-text"></span><span class="sg-url"></span>`;
    row.querySelector('.sg-text').textContent = it.text;
    if (it.type !== 'search') row.querySelector('.sg-url').textContent = (() => { try { return new URL(it.url).hostname; } catch { return ''; } })();
    row.addEventListener('mousedown', (e) => { e.preventDefault(); navigateTo(it.url); });
    $suggest.appendChild(row);
  });
  $suggest.classList.remove('hidden'); updateOverlay();
}
function hideSuggestions() { $suggest.classList.add('hidden'); updateOverlay(); }
function highlight() { [...$suggest.children].forEach((c, i) => c.classList.toggle('active', i === sgIndex)); }
function navigateTo(url) { hideSuggestions(); act('navigate', url); $address.blur(); }

$address.addEventListener('input', showSuggestions);
$address.addEventListener('focus', () => { if ($address.value.trim()) showSuggestions(); });
$address.addEventListener('blur', () => setTimeout(hideSuggestions, 120));
$address.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); sgIndex = Math.min(sgIndex + 1, sgItems.length - 1); highlight(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sgIndex = Math.max(sgIndex - 1, -1); highlight(); }
  else if (e.key === 'Escape') hideSuggestions();
  else if (e.key === 'Enter') { if (sgIndex >= 0 && sgItems[sgIndex]) navigateTo(sgItems[sgIndex].url); else navigateTo(toURL($address.value)); }
});

// ===== Menú =====
const $menu = $('menu');
$('menu-btn').addEventListener('click', (e) => { e.stopPropagation(); $menu.classList.toggle('hidden'); updateOverlay(); });
document.addEventListener('click', () => { if (!$menu.classList.contains('hidden')) { $menu.classList.add('hidden'); updateOverlay(); } });
$menu.addEventListener('click', (e) => {
  const a = e.target.closest('button')?.dataset.act; if (!a) return;
  if (a === 'zoom-in') { applyZoom(0.1); e.stopPropagation(); return; }
  if (a === 'zoom-out') { applyZoom(-0.1); e.stopPropagation(); return; }
  $menu.classList.add('hidden');
  if (a === 'incognito') window.rave.newIncognito();
  else if (a === 'find') openFind();
  else if (a === 'webstore') createTab('https://chromewebstore.google.com/');
  else if (a === 'update') { window.rave.updateCheck(); toast({ name: 'Actualizaciones' }, 'Buscando actualizaciones…'); }
  else if (a === 'capture') doCapture();
  else if (a === 'qr') { const t = activeTab(); if (t && !isInternal(t.url)) showQRPanel(t.url); else toast({ name: 'QR' }, 'No hay página activa para generar QR'); }
  else if (a === 'print') window.rave.print();
  else if (a === 'savepdf') window.rave.printPDF().then((f) => toast({ name: 'PDF guardado' }, f ? 'En Descargas' : 'Error al generar'));
  else if (a === 'pip') window.rave.pip();
  else if (a === 'share') { const t = activeTab(); if (t) { act('share'); toast({ name: 'URL copiada' }, t.url); } }
  else if (a === 'rl-add') { const t = activeTab(); if (t && !isInternal(t.url)) { act('rl-add'); toast({ name: 'Lista de lectura' }, 'Página guardada'); } }
  else if (a === 'sidebar') { openSidebar(); return; }
  else openPanel(a);
  updateOverlay();
});

// ===== Desplegable de extensiones =====
const $extMenu = $('ext-menu');
$('dl-btn').addEventListener('click', (e) => { e.stopPropagation(); openPanel('downloads'); });
$('ext-btn').addEventListener('click', (e) => { e.stopPropagation(); $extMenu.classList.toggle('hidden'); updateOverlay(); });
document.addEventListener('click', () => { if (!$extMenu.classList.contains('hidden')) { $extMenu.classList.add('hidden'); updateOverlay(); } });
$extMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const a = e.target.closest('.ext-manage')?.dataset.act;
  if (!a) return;
  $extMenu.classList.add('hidden'); updateOverlay();
  if (a === 'webstore') createTab('https://chromewebstore.google.com/');
  else openPanel('extensions');
});

// ===== Desplegable del Escudo =====
const $shieldMenu = $('shield-menu');
$('shield').addEventListener('click', (e) => {
  e.stopPropagation();
  $shieldMenu.classList.toggle('hidden');
  updateOverlay();
});
document.addEventListener('click', () => {
  if (!$shieldMenu.classList.contains('hidden')) {
    $shieldMenu.classList.add('hidden');
    updateOverlay();
  }
});
$shieldMenu.addEventListener('click', (e) => e.stopPropagation());

// Ocultar aviso de lista vacía de extensiones
const $extList = document.querySelector('browser-action-list');
if ($extList) {
  const updateEmptyState = () => {
    const hasActions = $extList.shadowRoot && $extList.shadowRoot.querySelectorAll('.action').length > 0;
    const $extEmpty = document.querySelector('.ext-empty');
    if ($extEmpty) $extEmpty.style.display = hasActions ? 'none' : 'block';
  };
  if ($extList.shadowRoot) {
    new MutationObserver(updateEmptyState).observe($extList.shadowRoot, { childList: true, subtree: true });
    updateEmptyState();
  } else {
    setTimeout(() => {
      if ($extList.shadowRoot) {
        new MutationObserver(updateEmptyState).observe($extList.shadowRoot, { childList: true, subtree: true });
        updateEmptyState();
      }
    }, 100);
  }
}

// ===== Zoom =====
function applyZoom(delta, absolute) {
  const t = activeTab(); if (!t) return;
  t.zoom = absolute !== undefined ? absolute : Math.min(3, Math.max(0.3, t.zoom + delta));
  act('zoom', t.zoom);
  $('zoom-level').textContent = Math.round(t.zoom * 100) + '%';
}

// ===== Buscar en página =====
const $findBar = $('find-bar'), $findInput = $('find-input');
function openFind() { $findBar.classList.remove('hidden'); measureLayout(); $findInput.focus(); $findInput.select(); }
function closeFind() { $findBar.classList.add('hidden'); $('find-count').textContent = ''; act('stopFind'); measureLayout(); }
function doFind(forward = true, findNext = false) {
  const text = $findInput.value;
  if (!text) { act('stopFind'); $('find-count').textContent = ''; return; }
  act('find', { text, opts: { forward, findNext } });
}
$findInput.addEventListener('input', () => doFind(true, false));
$findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doFind(!e.shiftKey, true); }
  else if (e.key === 'Escape') closeFind();
});
$('find-next').addEventListener('click', () => doFind(true, true));
$('find-prev').addEventListener('click', () => doFind(false, true));
$('find-close').addEventListener('click', closeFind);

// ===== Captura de pantalla =====
async function doCapture() {
  const dataUrl = await window.rave.capturePage();
  if (!dataUrl) { toast({ name: 'Captura' }, 'No se pudo capturar la pantalla'); return; }
  showScreenshotPanel(dataUrl);
}

function showScreenshotPanel(dataUrl) {
  const overlay = document.createElement('div');
  overlay.className = 'screenshot-overlay';
  overlay.innerHTML = `
    <div class="screenshot-modal">
      <div class="screenshot-header">
        <span class="screenshot-title">Captura de pantalla</span>
        <button class="icon-btn" id="ss-close">&#215;</button>
      </div>
      <div class="screenshot-preview">
        <img src="${dataUrl}" class="screenshot-img">
      </div>
      <div class="screenshot-actions">
        <button class="btn ghost" id="ss-copy">Copiar imagen</button>
        <button class="btn" id="ss-save">Guardar PNG</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  toastCount++; updateOverlay();

  const close = () => { overlay.remove(); toastCount = Math.max(0, toastCount - 1); updateOverlay(); };
  overlay.querySelector('#ss-close').addEventListener('click', close);
  overlay.querySelector('#ss-save').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `rave-capture-${Date.now()}.png`;
    a.click();
  });
  overlay.querySelector('#ss-copy').addEventListener('click', async () => {
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast({ name: 'Captura' }, 'Imagen copiada al portapapeles');
    } catch { toast({ name: 'Captura' }, 'No se pudo copiar la imagen'); }
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

// ===== QR de la URL actual =====
async function showQRPanel(url) {
  const dataUrl = await window.rave.qrGenerate(url);
  const overlay = document.createElement('div');
  overlay.className = 'qr-overlay';
  overlay.innerHTML = `
    <div class="qr-modal">
      <div class="qr-modal-title">Compartir esta p&#225;gina</div>
      ${dataUrl
        ? `<img src="${dataUrl}" width="200" height="200" class="qr-img">`
        : `<div class="qr-fallback">No se pudo generar el QR</div>`}
      <div class="qr-url"></div>
      <div class="qr-actions">
        <button class="btn ghost" id="qr-copy">Copiar URL</button>
        <button class="btn ghost" id="qr-close">Cerrar</button>
      </div>
    </div>`;
  overlay.querySelector('.qr-url').textContent = url;
  document.body.appendChild(overlay);
  toastCount++; updateOverlay();

  const close = () => { overlay.remove(); toastCount = Math.max(0, toastCount - 1); updateOverlay(); };
  overlay.querySelector('#qr-copy').addEventListener('click', () => { window.rave.copyText(url); toast({ name: 'URL copiada' }, url.slice(0, 60)); });
  overlay.querySelector('#qr-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

// ===== Barra de guardar contraseña =====
const $pwBar = $('pw-save-bar');
let pwSaveData = null;
$('pw-save-yes').addEventListener('click', async () => {
  if (pwSaveData) {
    const rawPassword = pwSaveData.password;
    const existing = passwords.findIndex((p) => p.domain === pwSaveData.domain);
    const entry = { domain: pwSaveData.domain, username: pwSaveData.username, password: await secEnc(rawPassword), ts: Date.now() };
    if (existing >= 0) passwords[existing] = entry; else passwords.unshift(entry);
    store.set('passwords', passwords);
    toast({ name: 'Contraseña guardada' }, pwSaveData.domain);
    // Verificar si la contraseña está comprometida (HIBP, k-anonymity)
    if (window.rave.checkPwned) {
      window.rave.checkPwned(rawPassword).then(count => {
        if (count > 0) {
          toast({ name: 'Contraseña comprometida' }, `Esta contraseña apareció en ${count.toLocaleString()} filtraciones de datos`);
        }
      }).catch(() => {});
    }
  }
  $pwBar.classList.add('hidden'); updateOverlay(); pwSaveData = null; measureLayout();
});
$('pw-save-no').addEventListener('click', () => { $pwBar.classList.add('hidden'); updateOverlay(); pwSaveData = null; measureLayout(); });

// ===== Panel overlay =====
const $panel = $('panel'), $panelTitle = $('panel-title'), $panelBody = $('panel-body');
$('panel-close').addEventListener('click', () => { $panel.classList.add('hidden'); updateOverlay(); });
$panel.addEventListener('click', (e) => { if (e.target === $panel) { $panel.classList.add('hidden'); updateOverlay(); } });

function openPanel(which) {
  const fns = {
    bookmarks: renderBookmarksPanel,
    history: renderHistoryPanel,
    downloads: renderDownloadsPanel,
    extensions: renderExtensionsPanel,
    settings: renderSettingsPanel,
    passwords: renderPasswordsPanel,
    cookies: renderCookiesPanel,
    notes: renderNotesPanel,
    sessions: renderSessionsPanel,
  };
  (fns[which] || (() => {}))();
  $panel.classList.remove('hidden'); updateOverlay();
}

function listRow(item, onOpen, onDel) {
  const row = document.createElement('div'); row.className = 'row';
  row.innerHTML = `<div class="r-main"><div class="r-title"></div><div class="r-url"></div></div><button class="r-del" title="Eliminar">${ICONS.close}</button>`;
  row.querySelector('.r-title').textContent = item.title || item.url;
  row.querySelector('.r-url').textContent = item.url;
  row.querySelector('.r-main').addEventListener('click', () => { onOpen(); $panel.classList.add('hidden'); updateOverlay(); });
  if (onDel) row.querySelector('.r-del').addEventListener('click', onDel); else row.querySelector('.r-del').remove();
  return row;
}

// ===== Panel: Marcadores =====
function renderBookmarksPanel() {
  $panelTitle.textContent = 'Marcadores'; $panelBody.innerHTML = '';
  if (!bookmarks.length) return void ($panelBody.innerHTML = '<div class="empty">Aún no tienes marcadores. Pulsa la estrella en la barra de direcciones.</div>');

  // Botones exportar/importar
  const actions = document.createElement('div'); actions.className = 'panel-actions';
  actions.innerHTML = `<button class="btn ghost" id="bm-export">${ICONS.export} Exportar</button>
    <label class="btn ghost" style="cursor:pointer" id="bm-import-label">${ICONS.import_} Importar<input type="file" id="bm-import" accept=".json" style="display:none"></label>`;
  $panelBody.appendChild(actions);
  $('bm-export').addEventListener('click', () => downloadJSON(bookmarks, 'rave-bookmarks.json'));
  $('bm-import').addEventListener('change', async (e) => {
    const text = await e.target.files[0]?.text();
    if (!text) return;
    try { const data = JSON.parse(text); if (Array.isArray(data)) { bookmarks = data; store.set('bookmarks', bookmarks); renderBookmarksBar(); renderBookmarksPanel(); } } catch {}
  });

  bookmarks.forEach((b, i) => $panelBody.appendChild(listRow(b, () => act('navigate', b.url),
    () => { bookmarks.splice(i, 1); store.set('bookmarks', bookmarks); renderBookmarksBar(); updateChrome(); renderBookmarksPanel(); })));
}

// ===== Panel: Historial =====
function renderHistoryPanel() {
  $panelTitle.textContent = 'Historial'; $panelBody.innerHTML = '';
  if (INCOGNITO) return void ($panelBody.innerHTML = '<div class="empty">En modo incógnito no se guarda historial.</div>');

  const searchWrap = document.createElement('div'); searchWrap.className = 'panel-search';
  searchWrap.innerHTML = `<span class="panel-search-ic">${ICONS.search}</span><input id="hist-search" class="hist-search" placeholder="Buscar en historial…" />`;
  $panelBody.appendChild(searchWrap);
  const listContainer = document.createElement('div'); listContainer.id = 'hist-list'; $panelBody.appendChild(listContainer);

  const DAY = 86400000;
  function dayLabel(ts) {
    const now = Date.now();
    const diff = now - ts;
    if (diff < DAY) return 'Hoy';
    if (diff < 2 * DAY) return 'Ayer';
    if (diff < 7 * DAY) return 'Últimos 7 días';
    if (diff < 30 * DAY) return 'Este mes';
    return 'Más antiguo';
  }

  const renderList = async (query = '') => {
    listContainer.innerHTML = '';
    const entries = await window.rave.historySearch(query);
    if (!entries || !entries.length) { listContainer.innerHTML = '<div class="empty">' + (query ? 'Sin resultados.' : 'Historial vacío.') + '</div>'; return; }
    let currentLabel = null;
    entries.forEach((e) => {
      const label = dayLabel(e.ts);
      if (label !== currentLabel) {
        currentLabel = label;
        const g = document.createElement('div'); g.className = 'hist-group-label'; g.textContent = label;
        listContainer.appendChild(g);
      }
      const row = document.createElement('div'); row.className = 'hist-entry';
      const favicon = e.favicon ? `<img class="hist-favicon" src="${e.favicon}" onerror="this.style.display='none'">` : `<span class="hist-favicon"></span>`;
      row.innerHTML = `${favicon}<div class="hist-info"><div class="hist-title"></div><div class="hist-url"></div></div><button class="hist-del" title="Eliminar">×</button>`;
      row.querySelector('.hist-title').textContent = e.title || e.url;
      row.querySelector('.hist-url').textContent = e.url;
      row.querySelector('.hist-info').addEventListener('click', () => { act('navigate', e.url); $panel.classList.add('hidden'); updateOverlay(); });
      row.querySelector('.hist-del').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await window.rave.historyDelete({ url: e.url, ts: e.ts });
        const idx = history.findIndex(h => h.url === e.url && h.ts === e.ts);
        if (idx !== -1) history.splice(idx, 1);
        row.remove();
      });
      listContainer.appendChild(row);
    });
  };

  renderList();
  $('hist-search').addEventListener('input', (e) => renderList(e.target.value));

  const a = document.createElement('div'); a.className = 'panel-actions';
  a.innerHTML = `<button class="btn ghost" id="hist-export">${ICONS.export} Exportar</button><button class="btn ghost hist-clear-btn" id="hist-clear">Borrar todo</button>`;
  $panelBody.appendChild(a);
  $('hist-export').addEventListener('click', async () => { const all = await window.rave.historySearch(''); downloadJSON(all, 'rave-history.json'); });
  $('hist-clear').addEventListener('click', async () => { await window.rave.historyClear(); history = []; renderHistoryPanel(); });
}

// ===== Panel: Descargas =====
function renderDownloadsPanel() {
  $panelTitle.textContent = 'Descargas'; $panelBody.innerHTML = '';
  if (!downloads.length) return void ($panelBody.innerHTML = '<div class="empty">No hay descargas.</div>');
  downloads.forEach((d) => {
    const row = document.createElement('div'); row.className = 'row';
    const done = d.state === 'completed';
    const stateLabel = done ? 'Completada' : d.state === 'cancelled' ? 'Cancelada' : 'En curso…';
    row.innerHTML = `
      <span class="row-icon">${done ? ICONS.check : d.state === 'cancelled' ? ICONS.close : ICONS.reload}</span>
      <div class="r-main">
        <div class="r-title"></div>
        <div class="r-url">${stateLabel}</div>
      </div>
      <div class="r-dl-actions">
        ${done ? `<button class="icon-btn r-open" title="Abrir archivo">${ICONS.externalLink}</button>
        <button class="icon-btn r-show" title="Mostrar en carpeta">${ICONS.folder}</button>` : ''}
        <button class="icon-btn r-del" title="Eliminar de la lista y del disco">${ICONS.trash}</button>
      </div>`;
    row.querySelector('.r-title').textContent = d.name;
    if (done) {
      row.querySelector('.r-open').addEventListener('click', () => window.rave.downloadOpen({ destPath: d.destPath, name: d.name }));
      row.querySelector('.r-show').addEventListener('click', () => window.rave.downloadShow({ destPath: d.destPath }));
    }
    row.querySelector('.r-del').addEventListener('click', async () => {
      if (d.destPath) await window.rave.downloadDelete({ destPath: d.destPath });
      downloads.splice(downloads.indexOf(d), 1); store.set('downloads', downloads); renderDownloadsPanel();
    });
    $panelBody.appendChild(row);
  });
  const a = document.createElement('div'); a.className = 'panel-actions';
  a.innerHTML = '<button class="btn ghost">Limpiar lista</button>';
  a.querySelector('button').addEventListener('click', async () => {
    for (const d of downloads) if (d.destPath) await window.rave.downloadDelete({ destPath: d.destPath });
    downloads = []; store.set('downloads', downloads); renderDownloadsPanel();
  });
  $panelBody.appendChild(a);
}

// ===== Panel: Extensiones =====
async function renderExtensionsPanel() {
  $panelTitle.textContent = 'Extensiones'; $panelBody.innerHTML = '';
  const list = await window.rave.listExtensions();
  const intro = document.createElement('div'); intro.className = 'set-row';
  intro.innerHTML = `<label>Extensiones de Chrome (descomprimidas)</label>
    <div style="font-size:12px;color:var(--ink-soft)">Coloca la carpeta de cada extensión (con su <b>manifest.json</b>) en la carpeta de extensiones y reinicia Rave.</div>`;
  $panelBody.appendChild(intro);
  if (!list.length) $panelBody.insertAdjacentHTML('beforeend', '<div class="empty">No hay extensiones cargadas.</div>');
  else list.forEach((x) => {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<div class="r-main"><div class="r-title"></div><div class="r-url"></div></div><button class="r-del" title="Eliminar">${ICONS.trash}</button>`;
    row.querySelector('.r-title').textContent = x.name;
    row.querySelector('.r-url').textContent = 'v' + x.version;
    row.querySelector('.r-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`¿Eliminar la extensión "${x.name}"?`)) {
        const ok = await window.rave.uninstallExtension(x.id);
        if (ok) renderExtensionsPanel(); else alert('No se pudo eliminar la extensión.');
      }
    });
    $panelBody.appendChild(row);
  });
  const a = document.createElement('div'); a.className = 'panel-actions';
  a.innerHTML = '<button class="btn">Abrir carpeta de extensiones</button>';
  a.querySelector('button').addEventListener('click', () => window.rave.openExtensionsFolder());
  $panelBody.appendChild(a);
}

// ===== Panel: Contraseñas =====
function renderPasswordsPanel() {
  $panelTitle.textContent = 'Contraseñas'; $panelBody.innerHTML = '';

  // Formulario para añadir contraseña manualmente
  const addForm = document.createElement('div'); addForm.className = 'pw-add-form';
  addForm.innerHTML = `
    <div class="pw-add-title">Añadir contraseña</div>
    <div class="pw-fields">
      <input id="pw-new-domain" placeholder="Dominio (ej: google.com)" />
      <input id="pw-new-user" placeholder="Usuario o correo" />
      <div class="pw-input-wrap">
        <input id="pw-new-pass" type="password" placeholder="Contraseña" />
        <button class="pw-eye" id="pw-new-eye">${ICONS.eye}</button>
      </div>
      <button class="btn" id="pw-new-save">Guardar</button>
    </div>`;
  $panelBody.appendChild(addForm);
  $('pw-new-eye').addEventListener('click', () => {
    const inp = $('pw-new-pass');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    $('pw-new-eye').innerHTML = inp.type === 'password' ? ICONS.eye : ICONS.eyeOff;
  });
  $('pw-new-save').addEventListener('click', async () => {
    const domain = $('pw-new-domain').value.trim().replace(/^https?:\/\//, '').split('/')[0];
    const username = $('pw-new-user').value.trim();
    const password = $('pw-new-pass').value;
    if (!domain || !username || !password) { alert('Completa todos los campos.'); return; }
    const existing = passwords.findIndex((p) => p.domain === domain && p.username === username);
    const entry = { domain, username, password: await secEnc(password), ts: Date.now() };
    if (existing >= 0) passwords[existing] = entry; else passwords.unshift(entry);
    store.set('passwords', passwords);
    $('pw-new-domain').value = ''; $('pw-new-user').value = ''; $('pw-new-pass').value = '';
    renderPasswordsPanel();
  });

  const sep = document.createElement('div'); sep.className = 'sep'; sep.style.margin = '4px 12px'; $panelBody.appendChild(sep);

  if (!passwords.length) { $panelBody.insertAdjacentHTML('beforeend', '<div class="empty">No hay contraseñas guardadas.</div>'); return; }

  // Búsqueda
  const searchWrap = document.createElement('div'); searchWrap.className = 'panel-search';
  searchWrap.innerHTML = `<span class="panel-search-ic">${ICONS.search}</span><input id="pw-search" placeholder="Buscar por dominio o usuario…" />`;
  $panelBody.appendChild(searchWrap);
  const listContainer = document.createElement('div'); listContainer.id = 'pw-list'; $panelBody.appendChild(listContainer);

  const renderPwList = (filter = '') => {
    listContainer.innerHTML = '';
    const filtered = filter ? passwords.filter((p) => (p.domain + p.username).toLowerCase().includes(filter.toLowerCase())) : passwords;
    if (!filtered.length) { listContainer.innerHTML = '<div class="empty">Sin resultados.</div>'; return; }
    filtered.forEach((p) => {
      const row = document.createElement('div'); row.className = 'pw-row';
      row.innerHTML = `
        <div class="pw-info">
          <div class="pw-domain">${ICONS.key}<span></span></div>
          <div class="pw-user">${ICONS.user}<span></span></div>
        </div>
        <div class="pw-actions">
          <button class="pw-copy-user" title="Copiar usuario">${ICONS.copy} Usuario</button>
          <button class="pw-copy-pass" title="Copiar contraseña">${ICONS.copy} Contraseña</button>
          <button class="pw-check-pwned" title="Verificar si está comprometida">Verificar</button>
          <button class="pw-del" title="Eliminar">${ICONS.trash}</button>
        </div>`;
      row.querySelector('.pw-domain span').textContent = p.domain;
      row.querySelector('.pw-user span').textContent = p.username;
      row.querySelector('.pw-copy-user').addEventListener('click', () => { window.rave.copyText(p.username); toast({ name: 'Usuario copiado' }, p.domain); });
      row.querySelector('.pw-copy-pass').addEventListener('click', async () => { window.rave.copyText(await secDec(p.password)); toast({ name: 'Contraseña copiada' }, p.domain); });
      row.querySelector('.pw-check-pwned').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true; btn.textContent = 'Verificando…';
        try {
          const plain = await secDec(p.password);
          const count = await window.rave.checkPwned(plain);
          if (count > 0) {
            btn.textContent = `Comprometida (${count.toLocaleString()}x)`;
            btn.style.color = 'var(--danger)';
          } else {
            btn.textContent = 'No comprometida';
            btn.style.color = 'var(--success)';
          }
        } catch { btn.textContent = 'Error'; btn.disabled = false; }
      });
      row.querySelector('.pw-del').addEventListener('click', () => {
        if (confirm(`¿Eliminar contraseña de ${p.domain}?`)) {
          passwords.splice(passwords.indexOf(p), 1); store.set('passwords', passwords); renderPwList(filter);
        }
      });
      listContainer.appendChild(row);
    });
  };
  renderPwList();
  $('pw-search').addEventListener('input', (e) => renderPwList(e.target.value));

  const a = document.createElement('div'); a.className = 'panel-actions';
  a.innerHTML = `<button class="btn ghost" id="pw-export">${ICONS.export} Exportar CSV</button>`;
  $panelBody.appendChild(a);
  $('pw-export').addEventListener('click', async () => {
    const rows = await Promise.all(passwords.map(async (p) => `${p.domain},${p.username},${await secDec(p.password)}`));
    const csv = ['Dominio,Usuario,Contraseña', ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a2 = document.createElement('a'); a2.href = URL.createObjectURL(blob); a2.download = 'rave-passwords.csv'; a2.click();
  });
}

// ===== Panel: Cookies =====
async function renderCookiesPanel() {
  $panelTitle.textContent = 'Cookies'; $panelBody.innerHTML = '';
  const t = activeTab();
  const url = t && !isInternal(t.url) ? t.url : null;

  $panelBody.innerHTML = `<div class="set-row"><label>${url ? `Cookies para: <b>${(() => { try { return new URL(url).hostname; } catch { return url; } })()}</b>` : 'Todas las cookies de la sesión'}</label></div>`;

  let cookies = await window.rave.getCookies(url);

  if (!cookies.length) { $panelBody.insertAdjacentHTML('beforeend', '<div class="empty">No hay cookies para este sitio.</div>'); return; }

  // Búsqueda
  const searchWrap = document.createElement('div'); searchWrap.className = 'panel-search';
  searchWrap.innerHTML = `<span class="panel-search-ic">${ICONS.search}</span><input id="ck-search" placeholder="Buscar cookie…" />`;
  $panelBody.appendChild(searchWrap);
  const listContainer = document.createElement('div'); listContainer.id = 'ck-list'; $panelBody.appendChild(listContainer);

  const renderCkList = (filter = '') => {
    listContainer.innerHTML = '';
    const filtered = filter ? cookies.filter((c) => (c.name + c.domain + (c.value || '')).toLowerCase().includes(filter.toLowerCase())) : cookies;
    if (!filtered.length) { listContainer.innerHTML = '<div class="empty">Sin resultados.</div>'; return; }
    filtered.forEach((c) => {
      const row = document.createElement('div'); row.className = 'ck-row';
      row.innerHTML = `
        <div class="ck-info">
          <div class="ck-name">${ICONS.cookie}<span></span></div>
          <div class="ck-domain"><span class="ck-domain-text"></span> <span class="ck-badge">${c.secure ? 'Segura' : ''}${c.httpOnly ? ' HttpOnly' : ''}</span></div>
          <div class="ck-value"></div>
        </div>
        <button class="ck-del" title="Eliminar">${ICONS.trash}</button>`;
      row.querySelector('.ck-name span').textContent = c.name;
      row.querySelector('.ck-domain-text').textContent = c.domain;
      const val = c.value || '';
      row.querySelector('.ck-value').textContent = val.length > 60 ? val.slice(0, 60) + '…' : val;
      row.querySelector('.ck-del').addEventListener('click', async () => {
        const cookieUrl = (c.secure ? 'https' : 'http') + '://' + c.domain.replace(/^\./, '') + c.path;
        await window.rave.deleteCookie(cookieUrl, c.name);
        cookies = cookies.filter((x) => x !== c);
        renderCkList(filter);
      });
      listContainer.appendChild(row);
    });
  };
  renderCkList();
  $('ck-search').addEventListener('input', (e) => renderCkList(e.target.value));

  if (url) {
    const a = document.createElement('div'); a.className = 'panel-actions';
    a.innerHTML = '<button class="btn ghost" id="ck-clear-all">Borrar todas las cookies del sitio</button>';
    $panelBody.appendChild(a);
    $('ck-clear-all').addEventListener('click', async () => {
      await window.rave.clearSiteCookies(url);
      toast({ name: 'Cookies eliminadas' }, (() => { try { return new URL(url).hostname; } catch { return url; } })());
      renderCookiesPanel();
    });
  }
}

// ===== Panel: Notas =====
function renderNotesPanel() {
  $panelTitle.textContent = 'Notas rápidas'; $panelBody.innerHTML = '';
  $panelBody.innerHTML = `
    <div class="notes-wrap">
      <textarea id="notes-area" placeholder="Escribe aquí tus notas… se guardan automáticamente.">${notes}</textarea>
      <div class="notes-footer">
        <span id="notes-chars" class="notes-count">0 caracteres</span>
        <div class="notes-btns">
          <button class="btn ghost" id="notes-copy">${ICONS.copy} Copiar</button>
          <button class="btn ghost" id="notes-clear">${ICONS.trash} Limpiar</button>
          <button class="btn ghost" id="notes-export">${ICONS.export} Exportar</button>
        </div>
      </div>
    </div>`;
  const area = $('notes-area');
  const countEl = $('notes-chars');
  const updateCount = () => { countEl.textContent = area.value.length + ' caracteres'; };
  updateCount();
  area.addEventListener('input', () => { notes = area.value; store.set('notes', notes); updateCount(); });
  $('notes-copy').addEventListener('click', () => { window.rave.copyText(area.value); toast({ name: 'Notas' }, 'Copiado al portapapeles'); });
  $('notes-clear').addEventListener('click', () => { if (confirm('¿Borrar todas las notas?')) { area.value = ''; notes = ''; store.set('notes', notes); updateCount(); } });
  $('notes-export').addEventListener('click', () => {
    const blob = new Blob([area.value], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'rave-notes.txt'; a.click();
  });
}

// ===== Panel: Sesiones =====
function renderSessionsPanel() {
  $panelTitle.textContent = 'Sesiones guardadas'; $panelBody.innerHTML = '';

  // Guardar sesión actual
  const saveWrap = document.createElement('div'); saveWrap.className = 'pw-add-form';
  saveWrap.innerHTML = `
    <div class="pw-add-title">Guardar sesión actual</div>
    <div class="pw-fields" style="flex-direction:row;align-items:center">
      <input id="sess-name" placeholder="Nombre de la sesión…" style="flex:1" />
      <button class="btn" id="sess-save">Guardar</button>
    </div>`;
  $panelBody.appendChild(saveWrap);

  $('sess-save').addEventListener('click', () => {
    const name = $('sess-name').value.trim() || `Sesión ${sessions.length + 1}`;
    const order = [...$tabs.querySelectorAll('.tab')].map((e) => tabs.get(+e.dataset.id)).filter(Boolean);
    const urls = order.filter((t) => !isInternal(t.url)).map((t) => ({ url: t.url, title: t.title }));
    if (!urls.length) { alert('No hay pestañas externas que guardar.'); return; }
    sessions.unshift({ name, urls, ts: Date.now() });
    store.set('sessions', sessions);
    $('sess-name').value = '';
    renderSessionsPanel();
  });

  const sep = document.createElement('div'); sep.className = 'sep'; sep.style.margin = '4px 12px'; $panelBody.appendChild(sep);

  if (!sessions.length) { $panelBody.insertAdjacentHTML('beforeend', '<div class="empty">No hay sesiones guardadas.</div>'); return; }

  sessions.forEach((s, si) => {
    const card = document.createElement('div'); card.className = 'sess-card';
    const date = new Date(s.ts).toLocaleDateString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    card.innerHTML = `
      <div class="sess-header">
        <div>
          <div class="sess-name">${s.name}</div>
          <div class="sess-meta">${s.urls.length} pestañas · ${date}</div>
        </div>
        <div class="sess-btns">
          <button class="btn" title="Restaurar">${ICONS.import_} Restaurar</button>
          <button class="btn ghost sess-del" title="Eliminar">${ICONS.trash}</button>
        </div>
      </div>
      <div class="sess-urls">${s.urls.map((u) => `<div class="sess-url-item">${ICONS.globe}<span></span></div>`).join('')}</div>`;
    card.querySelectorAll('.sess-url-item span').forEach((el, i) => { el.textContent = s.urls[i]?.title || s.urls[i]?.url || ''; });
    card.querySelector('.btn:not(.sess-del)').addEventListener('click', () => {
      s.urls.forEach((u) => createTab(u.url));
    });
    card.querySelector('.sess-del').addEventListener('click', () => {
      if (confirm(`¿Eliminar la sesión "${s.name}"?`)) {
        sessions.splice(si, 1); store.set('sessions', sessions); renderSessionsPanel();
      }
    });
    $panelBody.appendChild(card);
  });
}

// ===== Motores de busqueda - renderizar en ajustes =====
async function renderEnginesSettings(container) {
  const engines = await window.rave.getEngines();
  const BUILTIN = ['google','ddg','brave','bing','startpage'];
  container.innerHTML = `
    <div style="padding:10px 14px 4px">
      ${engines.map(e => `
        <div class="s-engine-row" style="display:flex;align-items:center;padding:6px 0;gap:8px">
          <label style="flex:1;display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
            <input type="radio" name="engine-main" value="${e.id}" ${e.default ? 'checked' : ''}>
            <span style="font-weight:500">${e.name}</span>
            <span style="font-size:11px;color:var(--ink-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">${e.url}</span>
          </label>
          ${!BUILTIN.includes(e.id) ? `<button class="icon-btn s-engine-del" data-id="${e.id}" style="width:24px;height:24px" title="Eliminar">×</button>` : ''}
        </div>`).join('')}
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;padding:8px 14px 12px;border-top:1px solid var(--border-soft)">
      <input id="eng-name" placeholder="Nombre" style="flex:1;min-width:100px;height:28px;padding:0 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface-2);color:var(--ink);font-size:12px">
      <input id="eng-url" placeholder="URL con %s (ej: https://ejemplo.com/search?q=%s)" style="flex:2;min-width:180px;height:28px;padding:0 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface-2);color:var(--ink);font-size:12px">
      <button class="btn ghost" id="eng-add-btn" style="height:28px;padding:0 12px;font-size:12px">Añadir</button>
    </div>`;
  container.querySelectorAll('input[name="engine-main"]').forEach(r => {
    r.addEventListener('change', async () => {
      const engines = await window.rave.setDefaultEngine(r.value);
      if (engines) { const def = engines.find(e => e.default); if (def) _activeEngineUrl = def.url; }
    });
  });
  container.querySelectorAll('.s-engine-del').forEach(b => {
    b.addEventListener('click', async () => { await window.rave.deleteEngine(b.dataset.id); renderEnginesSettings(container); });
  });
  const addBtn = container.querySelector('#eng-add-btn');
  if (addBtn) addBtn.addEventListener('click', async () => {
    const name = container.querySelector('#eng-name').value.trim();
    const url = container.querySelector('#eng-url').value.trim();
    if (name && url && url.includes('%s')) { await window.rave.addEngine({ name, url }); renderEnginesSettings(container); }
    else if (!url.includes('%s')) { alert('La URL debe contener %s como marcador de búsqueda.'); }
  });
}
// ===== Panel: Ajustes =====
async function renderSettingsPanel() {
  $panelTitle.textContent = 'Ajustes';
  const isDefault = await window.rave.isDefaultBrowser();
  const defaultStatus = isDefault
    ? 'Rave es tu navegador predeterminado.'
    : 'Rave no es el navegador predeterminado.';
  const th =(v, l) => `<option value="${v}" ${settings.theme === v ? 'selected' : ''}>${l}</option>`;
  const rf = (v, l) => `<option value="${v}" ${settings.readerFont === v ? 'selected' : ''}>${l}</option>`;
  // Interruptor (toggle) reutilizable.
  const sw = (k, id) => `<label class="switch"><input type="checkbox" id="${id}" ${settings[k] ? 'checked' : ''}/><span class="track"></span></label>`;
  // Fila con título + descripción opcional y un control a la derecha.
  const item = (title, desc, control, stacked) =>
    `<div class="set-item${stacked ? ' stacked' : ''}"><div class="set-item-text"><div class="set-item-title">${title}</div>${desc ? `<div class="set-item-desc">${desc}</div>` : ''}</div>${control}</div>`;

  $panelBody.innerHTML = `
    <div class="settings-wrap">
      <div class="settings-group">
        <div class="settings-section">${ICONS.home} Sistema</div>
        <div class="settings-card">
          ${item('Navegador predeterminado', defaultStatus, `<button class="btn ghost" id="s-default" ${isDefault ? 'disabled' : ''}>${isDefault ? 'Ya es predeterminado' : 'Establecer como predeterminado'}</button>`)}
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-section">${ICONS.search} Búsqueda</div>
        <div class="settings-card" id="s-engines-card">
          <div class="set-item"><span class="set-item-desc">Cargando motores…</span></div>
        </div>
        <div class="settings-card" style="margin-top:8px">
          ${item('Página de inicio', 'Vacío = nueva pestaña de Rave', `<input id="s-home" placeholder="https://…" value="${settings.homepage || ''}" />`, true)}
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-section">${ICONS.settings} Apariencia</div>
        <div class="settings-card">
          ${item('Tema', '', `<select id="s-theme">${th('system', 'Sistema')}${th('light', 'Claro')}${th('dark', 'Oscuro')}${th('eclipse', 'Orange Eclipse')}</select>`)}
          ${item('Barra de marcadores', 'Mostrar bajo la barra de direcciones', sw('showBookmarksBar', 's-bar'))}
          ${item('Animaciones', 'Transiciones y efectos de la interfaz', sw('animations', 's-anim'))}
          ${item('Fuente del modo lector', '', `<select id="s-rf">${rf('serif', 'Serif (Georgia)')}${rf('sans', 'Sans-serif (system)')}</select>`)}
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-section">${ICONS.reload} Rendimiento</div>
        <div class="settings-card">
          ${item('Poner pestañas en reposo', 'Libera RAM de las pestañas inactivas tras un tiempo', `<select id="s-sleep">
            <option value="0" ${settings.sleepTimeout == 0 ? 'selected' : ''}>Nunca</option>
            <option value="1" ${settings.sleepTimeout == 1 ? 'selected' : ''}>1 minuto</option>
            <option value="5" ${settings.sleepTimeout == 5 ? 'selected' : ''}>5 minutos</option>
            <option value="10" ${settings.sleepTimeout == 10 ? 'selected' : ''}>10 minutos</option>
            <option value="30" ${settings.sleepTimeout == 30 ? 'selected' : ''}>30 minutos</option>
            <option value="60" ${settings.sleepTimeout == 60 ? 'selected' : ''}>1 hora</option>
          </select>`)}
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-section">${ICONS.shield} Privacidad y seguridad</div>
        <div class="settings-card">
          ${item('Protección contra rastreo', 'Estricta añade DNT/GPC y modo solo HTTPS', `<select id="s-track">
            <option value="off" ${settings.trackingLevel === 'off' ? 'selected' : ''}>Desactivada</option>
            <option value="standard" ${settings.trackingLevel === 'standard' ? 'selected' : ''}>Estándar</option>
            <option value="strict" ${settings.trackingLevel === 'strict' ? 'selected' : ''}>Estricta</option>
          </select>`)}
          ${item('No rastrear (DNT) y GPC', 'Pide a las webs no rastrearte', sw('dnt', 's-dnt'))}
          ${item('Modo solo HTTPS', 'Fuerza conexiones seguras', sw('httpsOnly', 's-https'))}
          ${item('Borrar datos al salir', 'Limpia historial y caché al cerrar', sw('clearOnExit', 's-clear'))}
          ${item('Guardar contraseñas', 'Ofrecer guardar credenciales', sw('savePasswords', 's-pw'))}
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-section">${ICONS.shield_on} Escudos (predeterminados)</div>
        <div class="settings-card" id="s-shields-card">
          ${item('Escudos activos por defecto', 'Protección por defecto para sitios nuevos', `<label class="switch"><input type="checkbox" id="sd-enabled" ${settings.shieldsEnabled !== false ? 'checked' : ''}/><span class="track"></span></label>`)}
          ${item('Bloqueo de anuncios y rastreadores', '', `<select id="sd-adblock">
            <option value="aggressive" ${settings.shieldsAdBlock === 'aggressive' ? 'selected' : ''}>Agresivo</option>
            <option value="standard"   ${settings.shieldsAdBlock !== 'aggressive' && settings.shieldsAdBlock !== 'allow' ? 'selected' : ''}>Estándar</option>
            <option value="allow"      ${settings.shieldsAdBlock === 'allow' ? 'selected' : ''}>Permitir</option>
          </select>`)}
          ${item('JavaScript', 'Permitir JavaScript globalmente', `<label class="switch"><input type="checkbox" id="sd-js" ${settings.shieldsJS !== false ? 'checked' : ''}/><span class="track"></span></label>`)}
          ${item('Privacidad de huella digital', 'Añadir ruido al canvas fingerprint', `<label class="switch"><input type="checkbox" id="sd-fp" ${settings.shieldsFP !== false ? 'checked' : ''}/><span class="track"></span></label>`)}
          ${item('Cookies de terceros', '', `<select id="sd-cookies">
            <option value="blocked"    ${settings.shieldsCookies === 'blocked'    ? 'selected' : ''}>Bloquear todo</option>
            <option value="cross_site" ${settings.shieldsCookies !== 'blocked' && settings.shieldsCookies !== 'allow' ? 'selected' : ''}>Solo terceros</option>
            <option value="allow"      ${settings.shieldsCookies === 'allow'      ? 'selected' : ''}>Permitir</option>
          </select>`)}
          ${item('Actualizar HTTP a HTTPS', 'Redirigir a HTTPS cuando sea posible', `<label class="switch"><input type="checkbox" id="sd-https" ${settings.shieldsHTTPS !== false ? 'checked' : ''}/><span class="track"></span></label>`)}
        </div>
      </div>

      <div class="settings-group" id="s-perms-group">
        <div class="settings-section">${ICONS.key} Permisos de sitios</div>
        <div class="settings-card" id="s-perms-card">
          <div class="set-item"><span class="set-item-desc" style="padding:4px 0">Cargando…</span></div>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-section">${ICONS.download} Datos</div>
        <div class="settings-card">
          ${item('Exportar e importar', 'Copias de seguridad en JSON', `<div class="set-btn-row">
            <button class="btn ghost" id="s-exp-hist">Historial</button>
            <button class="btn ghost" id="s-exp-bm">Marcadores</button>
            <label class="btn ghost" style="cursor:pointer">Importar<input type="file" id="s-imp-bm" accept=".json" style="display:none"></label>
          </div>`, true)}
          ${item('Copia de seguridad completa', 'Exporta o importa todos los ajustes, marcadores, escudos y permisos', `<div class="set-btn-row">
            <button class="btn ghost" id="s-exp-all">Exportar todo</button>
            <label class="btn ghost" style="cursor:pointer">Importar todo<input type="file" id="s-imp-all" accept=".json" style="display:none"></label>
          </div>`, true)}
          ${item('Importar de otro navegador', 'Trae tus marcadores de Chrome, Edge o Brave', `<button class="btn ghost" id="s-imp-browser">Importar</button>`)}
          ${item('Borrar todos los datos', 'Historial, marcadores, contraseñas, notas y sesiones', `<button class="btn danger" id="s-clear-data">Borrar</button>`)}
        </div>
      </div>
    </div>

    <div class="settings-footer"><button class="btn" id="s-save">Guardar ajustes</button></div>`;

  // Cargar motores de busqueda en ajustes
  (async () => {
    const engCard = $('s-engines-card');
    if (engCard) await renderEnginesSettings(engCard);
  })();
  // Cargar y renderizar permisos guardados
  (async () => {
    const allPerms = await window.rave.getAllPerms();
    const card = $('s-perms-card'); if (!card) return;
    const origins = Object.keys(allPerms);
    if (!origins.length) {
      card.innerHTML = `<div class="set-item"><span class="set-item-desc">No hay permisos guardados para ningún sitio.</span></div>`;
      return;
    }
    card.innerHTML = origins.map((origin) => {
      const perms = allPerms[origin];
      const permList = Object.entries(perms).map(([perm, val]) => {
        const meta = PERM_META[perm] || { label: perm, icon: 'shield' };
        const ic = ICONS[meta.icon] || ICONS.shield;
        return `<div class="s-perm-row" data-origin="${origin}" data-perm="${perm}">
          <span class="s-perm-ic">${ic}</span>
          <span class="s-perm-label">${meta.label}</span>
          <span class="sp-perm-badge ${val}">${val === 'allow' ? 'Permitido' : 'Bloqueado'}</span>
          <select class="sp-perm-sel s-perm-sel" data-origin="${origin}" data-perm="${perm}">
            <option value="default">Predeterminado</option>
            <option value="allow"   ${val === 'allow' ? 'selected' : ''}>Permitir</option>
            <option value="block"   ${val === 'block' ? 'selected' : ''}>Bloquear</option>
          </select>
        </div>`;
      }).join('');
      let host = origin; try { host = new URL(origin).hostname; } catch {}
      return `<div class="s-perm-origin">
        <div class="s-perm-origin-header">
          <span class="s-perm-host">${host}</span>
          <button class="btn ghost s-perm-del-all" data-origin="${origin}" style="height:24px;padding:0 10px;font-size:11px">Borrar todos</button>
        </div>
        ${permList}
      </div>`;
    }).join('');

    card.querySelectorAll('.s-perm-sel').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const { origin: o, perm: p } = sel.dataset;
        await window.rave.setSitePerm(o, p, sel.value);
        const badge = sel.closest('.s-perm-row').querySelector('.sp-perm-badge');
        if (badge) { badge.className = `sp-perm-badge ${sel.value}`; badge.textContent = sel.value === 'allow' ? 'Permitido' : 'Bloqueado'; }
      });
    });
    card.querySelectorAll('.s-perm-del-all').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await window.rave.deleteSitePerms(btn.dataset.origin);
        btn.closest('.s-perm-origin').remove();
        if (!card.querySelector('.s-perm-origin')) card.innerHTML = `<div class="set-item"><span class="set-item-desc">No hay permisos guardados para ningún sitio.</span></div>`;
      });
    });
  })();

  $('s-default')?.addEventListener('click', async () => {
    const r = await window.rave.setDefaultBrowser();
    if (r?.dev) toast({ name: 'Navegador predeterminado' }, 'Configura Rave en la app instalada (no en desarrollo).');
    else if (r?.ok) toast({ name: 'Navegador predeterminado' }, 'Rave es ahora tu navegador predeterminado.');
    else toast({ name: 'Navegador predeterminado' }, 'Se abrió la configuración del sistema. Elige Rave como navegador.');
    renderSettingsPanel();
  });

  $('s-save').addEventListener('click', () => {
    settings = {
      engine: settings.engine, homepage: $('s-home').value.trim(),
      theme: $('s-theme').value, showBookmarksBar: $('s-bar').checked,
      animations: $('s-anim').checked, readerFont: $('s-rf').value,
      savePasswords: $('s-pw').checked,
      trackingLevel: $('s-track').value, dnt: $('s-dnt').checked,
      httpsOnly: $('s-https').checked, clearOnExit: $('s-clear').checked,
      sleepTimeout: parseInt($('s-sleep').value, 10),
      shieldsEnabled: $('sd-enabled')?.checked ?? true,
      shieldsAdBlock: $('sd-adblock')?.value ?? 'standard',
      shieldsJS: $('sd-js')?.checked ?? true,
      shieldsFP: $('sd-fp')?.checked ?? true,
      shieldsCookies: $('sd-cookies')?.value ?? 'cross_site',
      shieldsHTTPS: $('sd-https')?.checked ?? true,
    };
    store.set('settings', settings); applyTheme(); applyAnimations(); applyPrivacy(); applySleep();
    renderBookmarksBar();
    $panel.classList.add('hidden'); updateOverlay();
    toast({ name: 'Ajustes guardados' }, '');
  });
  $('s-exp-hist').addEventListener('click', async () => { const all = await window.rave.historySearch(''); downloadJSON(all, 'rave-history.json'); });
  $('s-exp-bm').addEventListener('click', () => downloadJSON(bookmarks, 'rave-bookmarks.json'));
  $('s-imp-bm').addEventListener('change', async (e) => {
    const text = await e.target.files[0]?.text();
    if (!text) return;
    try { const data = JSON.parse(text); if (Array.isArray(data)) { bookmarks = data; store.set('bookmarks', bookmarks); renderBookmarksBar(); toast({ name: 'Marcadores importados' }, data.length + ' marcadores'); } } catch { alert('Archivo inválido.'); }
  });
  // Exportar / importar todos los ajustes
  $('s-exp-all').addEventListener('click', async () => {
    const [perms, shields] = await Promise.all([
      window.rave.getAllPerms().catch(() => ({})),
      window.rave.getShieldsAll().catch(() => ({})),
    ]);
    const backup = {
      version: 1,
      date: new Date().toISOString(),
      settings,
      bookmarks,
      permissions: perms,
      shields,
    };
    downloadJSON(backup, `rave-backup-${new Date().toISOString().split('T')[0]}.json`);
  });
  $('s-imp-all').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      if (backup.version !== 1) { alert('Formato de copia de seguridad inválido.'); return; }
      if (backup.bookmarks && Array.isArray(backup.bookmarks)) {
        bookmarks = backup.bookmarks; store.set('bookmarks', bookmarks); renderBookmarksBar();
      }
      if (backup.settings && typeof backup.settings === 'object') {
        Object.assign(settings, backup.settings); store.set('settings', settings);
        applyTheme(); applyAnimations(); applyPrivacy(); applySleep();
      }
      toast({ name: 'Copia de seguridad' }, 'Ajustes importados correctamente');
      setTimeout(() => renderSettingsPanel(), 300);
    } catch { alert('Error al importar la copia de seguridad.'); }
  });
  $('s-imp-browser').addEventListener('click', async () => {
    const r = await window.rave.importBookmarks();
    if (!r || !r.bookmarks.length) { toast({ name: 'Importar' }, 'No se encontraron marcadores'); return; }
    const have = new Set(bookmarks.map((b) => b.url));
    let added = 0;
    for (const b of r.bookmarks) if (!have.has(b.url)) { bookmarks.push({ title: b.title, url: b.url }); have.add(b.url); added++; }
    store.set('bookmarks', bookmarks); renderBookmarksBar();
    toast({ name: `Importados de ${r.source}` }, `${added} marcadores nuevos`);
  });
  $('s-clear-data').addEventListener('click', () => {
    if (confirm('¿Borrar TODOS los datos del navegador? Esto incluye historial, marcadores, contraseñas, descargas, notas y sesiones. Esta acción no se puede deshacer.')) {
      localStorage.clear();
      location.reload();
    }
  });
}

function applyTheme() {
  if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', settings.theme);
}
function applyAnimations() {
  document.documentElement.classList.toggle('no-anim', !settings.animations);
}
function applyPrivacy() {
  window.rave.setPrivacy({
    level: settings.trackingLevel || 'standard',
    dnt: !!settings.dnt,
    httpsOnly: !!settings.httpsOnly,
    clearOnExit: !!settings.clearOnExit
  });
}
function applySleep() {
  window.rave.setSleep(settings.sleepTimeout ?? 10);
}

// ===== Utilidades =====
function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
}

// ===== Toasts genéricos =====
function toast(d, sub) {
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = `<span class="t-ic">${ICONS.download}</span><div class="t-body"><div class="t-title"></div><div class="t-sub"></div></div>`;
  el.querySelector('.t-title').textContent = d.name; el.querySelector('.t-sub').textContent = sub;
  toastCount++; updateOverlay();
  $('toasts').appendChild(el);
  setTimeout(() => { el.remove(); toastCount = Math.max(0, toastCount - 1); updateOverlay(); }, 4000);
}

// ===== Barra de descargas (estilo Edge) =====
const dlItems = new Map(); // id → { el, info }
let dlActiveCount = 0; // descargas en curso

function fmtBytes(b) {
  if (!b) return ''; if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function updateDlBadge() {
  const btn = $('dl-btn');
  if (!btn) return;
  btn.classList.toggle('has-badge', dlActiveCount > 0);
  const badge = btn.querySelector('.dl-badge');
  if (badge) badge.textContent = dlActiveCount > 0 ? dlActiveCount : '';
}

function addDownloadBar(info) {
  const { id, name, total } = info;
  dlActiveCount++; updateDlBadge();
  toastCount++; updateOverlay();

  const el = document.createElement('div'); el.className = 'dl-bar';
  el.innerHTML = `
    <span class="dl-ic">${ICONS.download}</span>
    <div class="dl-body">
      <div class="dl-name"></div>
      <div class="dl-progress-wrap">
        <div class="dl-progress-track"><div class="dl-progress-fill"></div></div>
        <span class="dl-size"></span>
      </div>
      <div class="dl-btns hidden">
        <button class="btn dl-open">Abrir archivo</button>
        <button class="btn ghost dl-show">Mostrar en carpeta</button>
      </div>
    </div>
    <div class="dl-controls">
      <button class="icon-btn dl-pause" title="Pausar">${ICONS.pause}</button>
      <button class="icon-btn dl-cancel" title="Cancelar">${ICONS.close}</button>
    </div>`;
  el.querySelector('.dl-name').textContent = name;
  if (total) el.querySelector('.dl-size').textContent = '0 / ' + fmtBytes(total);

  let paused = false;

  const dismiss = () => {
    el.classList.add('dl-out');
    el.addEventListener('animationend', () => {
      el.remove(); dlItems.delete(id);
      toastCount = Math.max(0, toastCount - 1); updateOverlay();
    }, { once: true });
  };

  el.querySelector('.dl-pause').addEventListener('click', () => {
    paused = !paused;
    if (paused) {
      window.rave.downloadPause(id);
      el.querySelector('.dl-pause').innerHTML = ICONS.reload;
      el.querySelector('.dl-pause').title = 'Reanudar';
      el.querySelector('.dl-progress-fill').classList.add('dl-paused');
      dlActiveCount = Math.max(0, dlActiveCount - 1); updateDlBadge();
    } else {
      window.rave.downloadResume(id);
      el.querySelector('.dl-pause').innerHTML = ICONS.pause;
      el.querySelector('.dl-pause').title = 'Pausar';
      el.querySelector('.dl-progress-fill').classList.remove('dl-paused');
      dlActiveCount++; updateDlBadge();
    }
  });

  el.querySelector('.dl-cancel').addEventListener('click', () => {
    window.rave.downloadCancel(id);
    if (!paused) { dlActiveCount = Math.max(0, dlActiveCount - 1); updateDlBadge(); }
    dismiss();
  });

  el.querySelector('.dl-open').addEventListener('click', async () => {
    el.querySelector('.dl-open').disabled = true;
    await window.rave.downloadOpen({ destPath: info.destPath, name });
    dismiss();
  });
  el.querySelector('.dl-show').addEventListener('click', () => {
    window.rave.downloadShow({ destPath: info.destPath });
  });

  $('toasts').appendChild(el);
  dlItems.set(id, { el, info });
}

window.rave.onDownloadStarted((d) => {
  if (!INCOGNITO) { downloads.unshift({ name: d.name, state: 'progressing', destPath: d.destPath, ts: Date.now() }); store.set('downloads', downloads); }
  addDownloadBar(d);
});

window.rave.onDownloadProgress((d) => {
  const item = dlItems.get(d.id); if (!item) return;
  const { el } = item;
  const fill = el.querySelector('.dl-progress-fill');
  if (d.total) { fill.style.width = Math.round((d.received / d.total) * 100) + '%'; }
  else { fill.classList.add('dl-indeterminate'); }
  if (d.total) el.querySelector('.dl-size').textContent = fmtBytes(d.received) + ' / ' + fmtBytes(d.total);
  if (d.paused) { fill.classList.add('dl-paused'); }
  else { fill.classList.remove('dl-paused'); }
});

window.rave.onDownloadDone((d) => {
  dlActiveCount = Math.max(0, dlActiveCount - 1); updateDlBadge();
  if (!INCOGNITO) {
    const r = downloads.find((x) => x.name === d.name && x.state === 'progressing');
    if (r) { r.state = d.state; if (d.destPath) r.destPath = d.destPath; store.set('downloads', downloads); }
  }
  const item = dlItems.get(d.id);
  if (!item) return;
  const { el, info } = item;
  if (d.destPath) info.destPath = d.destPath;
  const dlControls = el.querySelector('.dl-controls');
  if (dlControls) dlControls.style.display = 'none';
  if (d.state === 'completed') {
    el.querySelector('.dl-progress-wrap').style.display = 'none';
    el.querySelector('.dl-btns').classList.remove('hidden');
    // Auto-dismiss tras 30s si no interactúa
    setTimeout(() => { if (dlItems.has(d.id)) { const btn = el.querySelector('.dl-dismiss'); if (btn) btn.click(); } }, 30000);
  } else {
    el.querySelector('.dl-name').textContent = d.name + ' — Error';
    el.querySelector('.dl-progress-fill').style.width = '0';
    setTimeout(() => { if (dlItems.has(d.id)) { const btn = el.querySelector('.dl-dismiss'); if (btn) btn.click(); } }, 4000);
  }
});

// ===== Actualizaciones OTA =====
let updateToast = null;
window.rave.onUpdate((u) => {
  if (u.state === 'available') toast({ name: 'Rave ' + u.version }, 'Actualización disponible, descargando…');
  else if (u.state === 'downloaded') {
    if (updateToast) { updateToast.remove(); toastCount = Math.max(0, toastCount - 1); }
    updateToast = document.createElement('div');
    updateToast.className = 'toast';
    updateToast.innerHTML = `<span class="t-ic">${ICONS.download}</span>
      <div class="t-body"><div class="t-title">Actualización lista (${u.version})</div>
      <div class="t-sub">Reinicia para instalarla</div></div>
      <button class="btn" style="height:28px">Reiniciar</button>`;
    updateToast.querySelector('button').addEventListener('click', () => window.rave.updateInstall());
    toastCount++; updateOverlay();
    $('toasts').appendChild(updateToast);
  } else if (u.state === 'not-available') {
    if (updateToast) updateToast.remove();
    toast({ name: 'Actualizaciones' }, 'Ya estás usando la versión más reciente.');
  } else if (u.state === 'error') {
    if (updateToast) updateToast.remove();
    toast({ name: 'Actualizaciones' }, u.message || 'Sin actualizaciones o error de red');
  }
});

// ===== Reordenar pestañas =====
$tabs.addEventListener('dragover', (e) => {
  e.preventDefault();
  const dragging = $tabs.querySelector('.tab.dragging'); if (!dragging) return;
  const after = getDragAfter($tabs, e.clientX);
  if (after == null) $tabs.appendChild(dragging); else $tabs.insertBefore(dragging, after);
});
function getDragAfter(c, x) {
  return [...c.querySelectorAll('.tab:not(.dragging)')].reduce((closest, child) => {
    const box = child.getBoundingClientRect(); const off = x - box.left - box.width / 2;
    return (off < 0 && off > closest.offset) ? { offset: off, element: child } : closest;
  }, { offset: -Infinity, element: null }).element;
}
function syncTabOrder() { saveSession(); }

// ===== Menú contextual =====
// ===== Traducción inline =====
const LANGS = [
  ['es','Español'],['en','Inglés'],['pt','Portugués'],['fr','Francés'],
  ['de','Alemán'],['it','Italiano'],['ja','Japonés'],['ko','Coreano'],
  ['zh-CN','Chino (simp.)'],['ru','Ruso'],['ar','Árabe'],['nl','Neerlandés'],
];
let translateLang = store.get('translateLang', navigator.language.split('-')[0] || 'es');
let pageTranslated = false; // si la página actual está traducida

function buildLangSelect(currentLang, onChange) {
  const sel = document.createElement('select'); sel.className = 'tr-lang-sel';
  LANGS.forEach(([code, name]) => {
    const o = document.createElement('option'); o.value = code; o.textContent = name;
    if (code === currentLang) o.selected = true;
    sel.appendChild(o);
  });
  // si el idioma actual no está en la lista, añadirlo
  if (!LANGS.find(([c]) => c === currentLang)) {
    const o = document.createElement('option'); o.value = currentLang; o.textContent = currentLang; o.selected = true;
    sel.insertBefore(o, sel.firstChild);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

async function showTranslateTooltip(text, x, y) {
  let tip = document.getElementById('translate-tip');
  if (tip) tip.remove();
  tip = document.createElement('div'); tip.id = 'translate-tip';
  tip.innerHTML = `
    <div class="tr-header">
      <span class="tr-label">Traducir al:</span>
      <div class="tr-lang-wrap"></div>
      <button class="tr-close">${ICONS.close}</button>
    </div>
    <div class="tr-from"></div>
    <div class="tr-to">Traduciendo…</div>`;
  document.body.appendChild(tip);
  toastCount++; updateOverlay();

  const dismiss = () => { tip.remove(); toastCount = Math.max(0, toastCount - 1); updateOverlay(); };
  tip.querySelector('.tr-close').addEventListener('click', dismiss);

  const tw = 320, margin = 8;
  tip.style.left = Math.max(margin, Math.min(x, winW - tw - margin)) + 'px';
  tip.style.top = Math.max(margin, y + 12) + 'px';

  const doTranslate = async (lang) => {
    tip.querySelector('.tr-to').textContent = 'Traduciendo…';
    const r = await window.rave.translate(text, lang);
    if (r.ok) {
      tip.querySelector('.tr-from').textContent = text.length > 100 ? text.slice(0, 100) + '…' : text;
      tip.querySelector('.tr-to').textContent = r.translated;
    } else {
      tip.querySelector('.tr-to').textContent = 'Error al traducir';
    }
  };

  const sel = buildLangSelect(translateLang, (lang) => {
    translateLang = lang; store.set('translateLang', lang); doTranslate(lang);
  });
  tip.querySelector('.tr-lang-wrap').appendChild(sel);
  doTranslate(translateLang);
}

async function doTranslatePage() {
  if (pageTranslated) {
    // Restaurar idioma original
    const r = await window.rave.restorePage();
    if (r.ok) { pageTranslated = false; updateTranslateBar(false); }
    return;
  }
  showTranslateBar();
}

function showTranslateBar() {
  let bar = document.getElementById('translate-bar');
  if (bar) return;
  bar = document.createElement('div'); bar.id = 'translate-bar';
  bar.innerHTML = `
    <span class="tr-bar-label">Traducir página al:</span>
    <div class="tr-bar-lang"></div>
    <button class="btn tr-bar-go">Traducir</button>
    <button class="btn ghost tr-bar-cancel">${ICONS.close}</button>`;
  document.getElementById('chrome').appendChild(bar);
  toastCount++; updateOverlay(); measureLayout();

  const sel = buildLangSelect(translateLang, (lang) => { translateLang = lang; store.set('translateLang', lang); });
  bar.querySelector('.tr-bar-lang').appendChild(sel);

  bar.querySelector('.tr-bar-cancel').addEventListener('click', () => closeTranslateBar());
  bar.querySelector('.tr-bar-go').addEventListener('click', async () => {
    bar.querySelector('.tr-bar-go').textContent = 'Traduciendo…';
    bar.querySelector('.tr-bar-go').disabled = true;
    const r = await window.rave.translatePage(translateLang);
    if (r.ok) {
      pageTranslated = true;
      updateTranslateBar(true);
    } else {
      bar.querySelector('.tr-bar-go').textContent = 'Reintentar';
      bar.querySelector('.tr-bar-go').disabled = false;
    }
  });
}

function updateTranslateBar(translated) {
  const bar = document.getElementById('translate-bar');
  if (!bar) return;
  if (translated) {
    bar.innerHTML = `
      <span class="tr-bar-label">Página traducida al ${LANGS.find(([c]) => c === translateLang)?.[1] || translateLang}</span>
      <button class="btn ghost tr-bar-restore">Restaurar idioma original</button>
      <button class="btn ghost tr-bar-cancel">${ICONS.close}</button>`;
    bar.querySelector('.tr-bar-restore').addEventListener('click', async () => {
      const r = await window.rave.restorePage();
      if (r.ok) { pageTranslated = false; closeTranslateBar(); }
    });
    bar.querySelector('.tr-bar-cancel').addEventListener('click', closeTranslateBar);
  }
}

function closeTranslateBar() {
  const bar = document.getElementById('translate-bar');
  if (bar) { bar.remove(); toastCount = Math.max(0, toastCount - 1); updateOverlay(); measureLayout(); }
  pageTranslated = false;
}

// Cerrar la barra y el panel de seguridad al cambiar de pestaña
window.rave.onTabActivated(() => { closeTranslateBar(); closeSitePanel(); });

let $ctx = null;
function closeCtx() { if ($ctx) { $ctx.remove(); $ctx = null; updateOverlay(); } }
document.addEventListener('click', closeCtx);
window.rave.onContextMenu(({ id, p }) => {
  if (id !== activeId) return;
  const x = (p.panelOffsetX || 0) + p.x, y = measureLayout() + p.y;
  const items = [];
  if (p.linkURL) items.push(
    { label: 'Abrir enlace en pestaña nueva', action: () => createTab(p.linkURL) },
    { label: 'Copiar dirección del enlace', action: () => window.rave.copyText(p.linkURL) }, 'sep');
  if (p.srcURL && p.mediaType === 'image') items.push(
    { label: 'Guardar imagen', action: () => window.rave.downloadUrl(p.srcURL) },
    { label: 'Copiar dirección de la imagen', action: () => window.rave.copyText(p.srcURL) },
    { label: 'Abrir imagen en pestaña nueva', action: () => createTab(p.srcURL) }, 'sep');
  if (p.selectionText) items.push(
    { label: 'Copiar', action: () => act('copy') },
    { label: `Buscar "${p.selectionText.slice(0, 20)}${p.selectionText.length > 20 ? '…' : ''}"`, action: () => createTab(buildSearchUrl(p.selectionText)) },
    { label: 'Traducir selección', action: () => showTranslateTooltip(p.selectionText, x, y) },
    'sep');
  if (p.isEditable) items.push(
    { label: 'Cortar', action: () => act('cut'), disabled: !p.selectionText },
    { label: 'Copiar', action: () => act('copy'), disabled: !p.selectionText },
    { label: 'Pegar', action: () => act('paste') }, 'sep');
  const t = activeTab();
  const pageUrl = t?.url;
  items.push(
    { label: 'Atrás', action: () => act('back'), disabled: !t?.back },
    { label: 'Adelante', action: () => act('forward'), disabled: !t?.fwd },
    { label: 'Recargar', action: () => act('reload') }, 'sep',
    { label: 'Traducir página', action: () => doTranslatePage() },
    { label: 'Captura de pantalla', action: () => doCapture() },
    { label: 'Crear QR de esta página', action: () => { const t = activeTab(); if (t && !isInternal(t.url)) showQRPanel(t.url); } }, 'sep',
    { label: 'Modo lector', action: () => window.rave.injectReader() }, 'sep',
    { label: 'Inspeccionar elemento', action: () => act('inspect', { x: p.x, y: p.y }) });
  showContextMenu(items, x, y);
});
function showContextMenu(items, x, y) {
  closeCtx();
  $ctx = document.createElement('div'); $ctx.id = 'ctx';
  for (const it of items) {
    if (it === 'sep') { const s = document.createElement('div'); s.className = 'sep'; $ctx.appendChild(s); continue; }
    const b = document.createElement('button'); b.textContent = it.label;
    if (it.disabled) b.disabled = true; else b.addEventListener('click', () => { closeCtx(); it.action(); });
    $ctx.appendChild(b);
  }
  document.body.appendChild($ctx); updateOverlay();
  const r = $ctx.getBoundingClientRect();
  $ctx.style.left = Math.max(4, Math.min(x, winW - r.width - 8)) + 'px';
  $ctx.style.top = Math.max(4, Math.min(y, winH - r.height - 8)) + 'px';
}

// ===== Permisos por sitio =====
let permOpen = false;
let welcomeOpen = false;
let toastCount = 0;
let sidebarOpen = false;
let previewOpen = false;
const PERM_TEXT = {
  media: 'usar tu cámara y micrófono', audioCapture: 'usar tu micrófono', videoCapture: 'usar tu cámara',
  geolocation: 'conocer tu ubicación', notifications: 'enviarte notificaciones',
  midi: 'usar dispositivos MIDI', midiSysex: 'usar dispositivos MIDI',
  clipboard: 'leer tu portapapeles', 'clipboard-read': 'leer tu portapapeles',
  'display-capture': 'capturar tu pantalla', openExternal: 'abrir otra aplicación'
};
window.rave.onPermissionRequest(({ id, permission, origin }) => {
  let host = origin; try { host = new URL(origin).hostname; } catch {}
  const wrap = document.createElement('div');
  wrap.className = 'perm-dialog';
  wrap.innerHTML = `<div class="perm-card">
    <div class="perm-icon">${ICONS.shield}</div>
    <div class="perm-title"></div>
    <label class="perm-remember"><input type="checkbox" id="perm-remember" /> Recordar mi decisión para este sitio</label>
    <div class="perm-actions">
      <button class="btn ghost" id="perm-block">Bloquear</button>
      <button class="btn" id="perm-allow">Permitir</button>
    </div></div>`;
  wrap.querySelector('.perm-title').textContent = `${host} quiere ${PERM_TEXT[permission] || ('usar: ' + permission)}`;
  document.body.appendChild(wrap);
  permOpen = true; updateOverlay();
  const done = (allow) => {
    window.rave.permissionResponse({ id, allow, remember: wrap.querySelector('#perm-remember').checked });
    wrap.remove(); permOpen = false; updateOverlay();
  };
  wrap.querySelector('#perm-allow').addEventListener('click', () => done(true));
  wrap.querySelector('#perm-block').addEventListener('click', () => done(false));
});

// ===== Disposición / overlay =====
function measureLayout() {
  const h = $('chrome').offsetHeight + ($('pw-save-bar').classList.contains('hidden') ? 0 : $('pw-save-bar').offsetHeight);
  window.rave.setLayout(h);
  return h;
}
function updateOverlay() {
  const on = !$menu.classList.contains('hidden') || !$panel.classList.contains('hidden') ||
    !$suggest.classList.contains('hidden') || !$extMenu.classList.contains('hidden') ||
    !$shieldMenu.classList.contains('hidden') || !!$ctx || permOpen || welcomeOpen || toastCount > 0 || sidebarOpen || previewOpen;
  window.rave.setOverlay(on);
}
new ResizeObserver(measureLayout).observe($('chrome'));
window.addEventListener('resize', measureLayout);

// ===== Controles de ventana =====
const $winMax = $('win-max');
$('win-min').addEventListener('click', () => window.rave.winMinimize());
$winMax.addEventListener('click', () => window.rave.winMaximize());
$('win-close').addEventListener('click', () => {
  saveSessionNow();
  window.rave.winClose();
});
function setMaxIcon(m) { $winMax.innerHTML = m ? ICONS.win_restore : ICONS.win_max; }
window.rave.onWinState(setMaxIcon);
window.rave.winIsMaximized().then(setMaxIcon);

// ===== Atajos =====
window.addEventListener('keydown', (e) => {
  const c = e.ctrlKey, s = e.shiftKey, k = e.key.toLowerCase();
  if (c && s && k === 't') { e.preventDefault(); const u = closedTabs.pop(); if (u) createTab(u); }
  else if (c && k === 't') { e.preventDefault(); createTab(); }
  else if (c && k === 'w') { e.preventDefault(); if (activeId != null) window.rave.tabClose(activeId); }
  else if (c && k === 'l') { e.preventDefault(); $address.focus(); $address.select(); }
  else if (c && k === 'r') { e.preventDefault(); act('reload'); }
  else if (c && k === 'd') { e.preventDefault(); toggleBookmark(); }
  else if (c && k === 'f') { e.preventDefault(); openFind(); }
  else if (c && s && k === 'n') { e.preventDefault(); window.rave.newIncognito(); }
  else if (c && k === 'h') { e.preventDefault(); openPanel('history'); }
  else if (c && s && k === 'r') { e.preventDefault(); window.rave.injectReader(); }
  else if (c && s && k === 'p') { e.preventDefault(); doCapture(); }
  else if (c && s && k === 'd') { e.preventDefault(); if (activeId != null) window.rave.tabSplitToggle(activeId, newTabURL()); }
  else if (c && s && k === 'b') { e.preventDefault(); settings.showBookmarksBar = !settings.showBookmarksBar; store.set('settings', settings); renderBookmarksBar(); }
  else if (c && k === 'p') { e.preventDefault(); window.rave.print(); }
  else if (c && (k === '+' || k === '=')) { e.preventDefault(); applyZoom(0.1); }
  else if (c && k === '-') { e.preventDefault(); applyZoom(-0.1); }
  else if (c && k === '0') { e.preventDefault(); applyZoom(0, 1); }
  else if (k === 'escape') closeFind();
});


// ===== Escudo =====
// Optimizado: se pausa con la ventana oculta y solo toca el DOM si cambia.
let _lastBlocked = -1;
setInterval(async () => {
  if (document.hidden) return;
  try {
    const count = await window.rave.getBlockedCount();
    if (count === _lastBlocked) return;
    _lastBlocked = count;
    $('shield-count').textContent = count;
    const menuCount = $('shield-menu-count');
    if (menuCount) menuCount.textContent = count;
  } catch {}
}, 1200);

// ===== Arranque =====
applyTheme();
applyAnimations();
applyPrivacy();
applySleep();
renderBookmarksBar();
measureLayout();
// Iconos en botones del menú (recargamos tras crear el HTML)
document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = ICONS[el.dataset.icon] || ''; });
// Recuperación tras cierre inesperado: marcamos "en ejecución" al arrancar y
// "cierre limpio" al descargar. Si al abrir no estaba limpio, fue un crash.
const wasClean = INCOGNITO ? true : store.get('cleanExit', true);
if (!INCOGNITO) store.set('cleanExit', false);
window.addEventListener('beforeunload', () => { if (!INCOGNITO) store.set('cleanExit', true); });

const saved = INCOGNITO ? [] : store.get('session', []);
if (!wasClean && saved.length) {
  setTimeout(() => toast({ name: 'Sesión restaurada' }, 'Recuperada tras un cierre inesperado'), 800);
}
if (saved.length) {
  // Mapa de pestañas que necesitan activar split al terminar de cargar
  const pendingSplit = new Map(); // id → { splitUrl, splitRatio, activeSide }

  saved.forEach((item) => {
    if (typeof item === 'string') {
      createTab(item);
    } else if (item && typeof item === 'object') {
      createTab(item.url).then((id) => {
        if (!id) return;
        if (item.isSplit) pendingSplit.set(id, { splitUrl: item.splitUrl, splitRatio: item.splitRatio, activeSide: item.activeSide });
        if (item.pinned) {
          const t = tabs.get(id);
          if (t && !t.pinned) { t.pinned = true; t.el.classList.add('pinned'); reorderPinned(); }
        }
      });
    }
  });

  // pendingSplit se procesa en el listener onTabUpdated global (ver línea ~246)
  window._pendingSplit = pendingSplit;
} else {
  createTab();
}

// ===== Pantalla dividida =====
function updateSplitIndicator() {
  const t = activeTab();
  const $indicator = $('split-indicator');
  if (!$indicator) return;
  if (t && t.isSplit) {
    $indicator.classList.remove('hidden');
    const side = t.activeSide || 'primary';
    $indicator.querySelector('.left').classList.toggle('active', side === 'primary');
    $indicator.querySelector('.right').classList.toggle('active', side === 'secondary');
  } else {
    $indicator.classList.add('hidden');
  }
}

function updateSplitButton() {
  const t = activeTab();
  const $btn = $('split-btn');
  if (!$btn) return;
  $btn.classList.toggle('active', !!(t && t.isSplit));
}

$('split-btn').addEventListener('click', () => {
  if (activeId !== null) {
    window.rave.tabSplitToggle(activeId, newTabURL());
  }
});

window.rave.onTabSplitState(({ id, isSplit, activeSide, primaryUrl, splitUrl }) => {
  const t = tabs.get(id);
  if (!t) return;
  t.isSplit = isSplit;
  t.activeSide = activeSide;
  if (!isSplit) {
    t.primaryUrl = null;
    t.splitUrl = null;
    t.splitRatio = null;
  } else {
    if (primaryUrl) t.primaryUrl = primaryUrl;
    if (splitUrl) t.splitUrl = splitUrl;
  }
  t.el.classList.toggle('split-tab', isSplit);
  
  // Manejar icono de división en la pestaña
  let splitIcon = t.el.querySelector('.tab-split-icon');
  if (isSplit) {
    if (!splitIcon) {
      splitIcon = document.createElement('span');
      splitIcon.className = 'tab-split-icon';
      splitIcon.innerHTML = ICONS.split;
      t.el.insertBefore(splitIcon, t.el.querySelector('.close'));
    }
  } else {
    if (splitIcon) {
      splitIcon.remove();
    }
  }
  
  if (id === activeId) {
    updateSplitIndicator();
    updateSplitButton();
  }
});

window.rave.onTabSplitFocus(({ id, side }) => {
  const t = tabs.get(id);
  if (!t) return;
  t.activeSide = side;
  if (id === activeId) {
    updateSplitIndicator();
  }
});

window.rave.onTabSplitRatioUpdated(({ id, splitRatio }) => {
  const t = tabs.get(id);
  if (t) {
    t.splitRatio = splitRatio;
  }
});

window.rave.onSaveSession(() => {
  saveSession();
});

// ===== Arrastrar y soltar para dividir pestañas =====
const $dropLeft = $('drop-left');
const $dropRight = $('drop-right');

$dropLeft.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (draggedTabId !== null && draggedTabId !== activeId) {
    $dropLeft.classList.add('hover');
  }
});
$dropLeft.addEventListener('dragleave', () => {
  $dropLeft.classList.remove('hover');
});
$dropLeft.addEventListener('drop', (e) => {
  e.preventDefault();
  $dropLeft.classList.remove('hover');
  if (draggedTabId !== null && draggedTabId !== activeId) {
    window.rave.tabSplitMerge(activeId, draggedTabId, 'left');
  }
});

$dropRight.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (draggedTabId !== null && draggedTabId !== activeId) {
    $dropRight.classList.add('hover');
  }
});
$dropRight.addEventListener('dragleave', () => {
  $dropRight.classList.remove('hover');
});
$dropRight.addEventListener('drop', (e) => {
  e.preventDefault();
  $dropRight.classList.remove('hover');
  if (draggedTabId !== null && draggedTabId !== activeId) {
    window.rave.tabSplitMerge(activeId, draggedTabId, 'right');
  }
});

// ===== Vista previa de pestaña =====
let previewTimer = null;
let $preview = null;

function showTabPreview(tabId, anchorEl) {
  previewTimer = setTimeout(async () => {
    const dataUrl = await window.rave.tabPreview(tabId);
    if (!dataUrl) return;
    if (!$preview) {
      $preview = document.createElement('div');
      $preview.id = 'tab-preview';
      document.body.appendChild($preview);
    }
    const tab = tabs.get(tabId);
    $preview.innerHTML = `
      <div class="tp-thumb"><img src="${dataUrl}" width="280" height="158"></div>
      <div class="tp-title"></div>`;
    $preview.querySelector('.tp-title').textContent = tab?.title || '';
    const rect = anchorEl.getBoundingClientRect();
    $preview.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 296)) + 'px';
    $preview.style.top = (rect.bottom + 4) + 'px';
    previewOpen = true;
    updateOverlay();
    $preview.classList.add('visible');
  }, 600);
}

function hideTabPreview() {
  clearTimeout(previewTimer);
  if ($preview) $preview.classList.remove('visible');
  previewOpen = false;
  updateOverlay();
}

// ===== Controles de medios =====
const $mediaBar = $('media-bar');
const $mediaPlay = $('media-play');
const $mediaTitle = $('media-title');
const $mediaArtist = $('media-artist');
const $mediaArt = $('media-art');
let mediaPlaying = false;

window.rave.onMediaState(async ({ id, playing }) => {
  if (!playing) {
    if (id === activeId) { $mediaBar.classList.add('hidden'); measureLayout(); }
    return;
  }
  const info = await window.rave.mediaInfo();
  if (info) {
    mediaPlaying = info.playing;
    $mediaTitle.textContent = info.title || 'Reproduciendo';
    $mediaArtist.textContent = info.artist || '';
    $mediaPlay.textContent = info.playing ? '⏸' : '▶';
    if (info.artwork) { $mediaArt.src = info.artwork; $mediaArt.style.display = 'block'; }
    else $mediaArt.style.display = 'none';
    $mediaBar.classList.remove('hidden');
    measureLayout();
  }
});

$mediaPlay.addEventListener('click', () => {
  mediaPlaying = !mediaPlaying;
  window.rave.mediaControl(mediaPlaying ? 'play' : 'pause');
  $mediaPlay.textContent = mediaPlaying ? '⏸' : '▶';
});
$('media-prev').addEventListener('click', () => window.rave.mediaControl('prev'));
$('media-next').addEventListener('click', () => window.rave.mediaControl('next'));

// ===== Visor de PDF integrado =====
window.rave.onOpenPDF((url) => {
  createTab(url);
});

// ===== Panel lateral (Sidebar) =====
const $sidebar = $('sidebar');
const $sidebarBody = $('sidebar-body');
let sidebarActivePanel = 'bookmarks';

function openSidebar(panel) {
  sidebarActivePanel = panel || sidebarActivePanel;
  sidebarOpen = true;
  $sidebar.classList.remove('hidden');
  document.querySelectorAll('.sidebar-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.panel === sidebarActivePanel);
  });
  renderSidebarPanel();
  updateOverlay();
}

function closeSidebar() {
  sidebarOpen = false;
  $sidebar.classList.add('hidden');
  updateOverlay();
}

async function renderSidebarPanel() {
  if (sidebarActivePanel === 'bookmarks') {
    $sidebarBody.innerHTML = `<div class="sb-search-wrap"><input id="sb-bm-search" class="sb-search" placeholder="Buscar marcadores…"></div><div id="sb-bm-list"></div>`;
    const list = $('sb-bm-list');
    const renderBM = (q) => {
      const filtered = bookmarks.filter(b => !q || (b.title || '').toLowerCase().includes(q) || (b.url || '').toLowerCase().includes(q));
      if (!filtered.length) { list.innerHTML = '<div class="sb-empty">Sin marcadores</div>'; return; }
      list.innerHTML = '';
      filtered.forEach(b => {
        let host = '';
        try { host = new URL(b.url).hostname; } catch {}
        const item = document.createElement('div');
        item.className = 'sb-item';
        item.dataset.url = b.url;
        item.innerHTML = `<img class="sb-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=16" width="14" height="14" onerror="this.style.display='none'"><span class="sb-title"></span>`;
        item.querySelector('.sb-title').textContent = b.title || b.url;
        item.addEventListener('click', () => { createTab(b.url); });
        list.appendChild(item);
      });
    };
    renderBM('');
    $('sb-bm-search').addEventListener('input', e => renderBM(e.target.value.toLowerCase()));
  } else if (sidebarActivePanel === 'history') {
    $sidebarBody.innerHTML = `<div class="sb-search-wrap"><input id="sb-hist-search" class="sb-search" placeholder="Buscar historial…"></div><div id="sb-hist-list"></div>`;
    const renderHist = async (q) => {
      const entries = await window.rave.historySearch(q);
      const list = $('sb-hist-list');
      if (!list) return;
      if (!entries || !entries.length) { list.innerHTML = '<div class="sb-empty">Sin historial</div>'; return; }
      list.innerHTML = '';
      entries.slice(0, 80).forEach(e => {
        let host = '';
        try { host = new URL(e.url).hostname; } catch {}
        const item = document.createElement('div');
        item.className = 'sb-item';
        item.innerHTML = `<img class="sb-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=16" width="14" height="14" onerror="this.style.display='none'"><span class="sb-title"></span>`;
        item.querySelector('.sb-title').textContent = e.title || e.url;
        item.addEventListener('click', () => { createTab(e.url); });
        list.appendChild(item);
      });
    };
    renderHist('');
    $('sb-hist-search').addEventListener('input', e => renderHist(e.target.value));
  } else if (sidebarActivePanel === 'readinglist') {
    $sidebarBody.innerHTML = `<div id="sb-rl-list"></div>`;
    const renderRL = async () => {
      const entries = await window.rave.rlGet();
      const list = $('sb-rl-list');
      if (!list) return;
      if (!entries || !entries.length) { list.innerHTML = '<div class="sb-empty">Lista de lectura vacía.<br>Usa el menú ☰ → "Guardar en lista de lectura".</div>'; return; }
      list.innerHTML = '';
      entries.forEach(e => {
        let host = '';
        try { host = new URL(e.url).hostname; } catch {}
        const item = document.createElement('div');
        item.className = 'sb-item sb-rl-item';
        item.innerHTML = `<img class="sb-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=16" width="14" height="14" onerror="this.style.display='none'"><span class="sb-title"></span><button class="sb-rl-del" title="Eliminar">×</button>`;
        item.querySelector('.sb-title').textContent = e.title || e.url;
        item.querySelector('.sb-rl-del').addEventListener('click', async (ev) => { ev.stopPropagation(); await window.rave.rlDelete(e.url); renderRL(); });
        item.addEventListener('click', (ev) => { if (!ev.target.classList.contains('sb-rl-del')) createTab(e.url); });
        list.appendChild(item);
      });
    };
    renderRL();
  } else if (sidebarActivePanel === 'notes') {
    $sidebarBody.innerHTML = `<textarea id="sb-notes" class="sb-notes" placeholder="Notas…"></textarea>`;
    const area = $('sb-notes');
    area.value = notes;
    area.addEventListener('input', e => { notes = e.target.value; store.set('notes', notes); });
  }
}

document.querySelectorAll('.sidebar-tab').forEach(t => {
  t.addEventListener('click', () => {
    sidebarActivePanel = t.dataset.panel;
    document.querySelectorAll('.sidebar-tab').forEach(x => x.classList.toggle('active', x === t));
    renderSidebarPanel();
  });
});
$('sidebar-close').addEventListener('click', closeSidebar);

// ===== Bienvenida (primera ejecución) =====
function dismissWelcome() {
  store.set('welcomeSeen', true);
  $('welcome')?.classList.add('hidden');
  welcomeOpen = false; updateOverlay();
}

if (!INCOGNITO && !store.get('welcomeSeen', false)) {
  $('welcome')?.classList.remove('hidden');
  welcomeOpen = true; updateOverlay();   // expande la UI a pantalla completa
  $('welcome-start')?.addEventListener('click', dismissWelcome);
  $('welcome-default')?.addEventListener('click', async () => {
    const r = await window.rave.setDefaultBrowser();
    if (r?.ok) toast({ name: 'Rave' }, 'Navegador predeterminado configurado.');
    else toast({ name: 'Rave' }, 'Se abrió la configuración del sistema.');
    dismissWelcome();
  });
}

