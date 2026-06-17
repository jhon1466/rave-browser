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

const ENGINES = {
  ddg:    { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  google: { name: 'Google',     url: 'https://www.google.com/search?q=' },
  bing:   { name: 'Bing',       url: 'https://www.bing.com/search?q=' },
  brave:  { name: 'Brave',      url: 'https://search.brave.com/search?q=' },
  ecosia: { name: 'Ecosia',     url: 'https://www.ecosia.org/search?q=' },
};
let settings = store.get('settings', {
  engine: 'ddg', homepage: '', theme: 'system',
  savePasswords: true, showBookmarksBar: true, animations: true, readerFont: 'serif'
});
let bookmarks = store.get('bookmarks', []);
let history = INCOGNITO ? [] : store.get('history', []);
let downloads = INCOGNITO ? [] : store.get('downloads', []);
let passwords = store.get('passwords', []); // [{domain, username, password(encrypted), ts}]
let notes = store.get('notes', '');
let sessions = store.get('sessions', []); // [{name, urls, ts}]
const closedTabs = [];

const enginePrefix = () => (ENGINES[settings.engine] || ENGINES.ddg).url;
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
  return enginePrefix() + encodeURIComponent(t);
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
    `<span class="title">Nueva pestaña</span><span class="close" title="Cerrar">${ICONS.close}</span>`;
  $tabs.appendChild(el);
  el.addEventListener('click', (e) => { if (!e.target.closest('.close')) window.rave.tabSelect(id); });
  el.querySelector('.close').addEventListener('click', (e) => { e.stopPropagation(); window.rave.tabClose(id); });
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
    isSplit: false, activeSide: 'primary'
  });
  saveSession();
});

window.rave.onTabActivated(({ id }) => {
  activeId = id;
  for (const [tid, t] of tabs) t.el.classList.toggle('active', tid === id);
  updateChrome();
});

window.rave.onTabClosed(({ id }) => {
  const t = tabs.get(id);
  if (!t) return;
  if (!isInternal(t.url)) closedTabs.push(t.url);
  const order = [...$tabs.querySelectorAll('.tab')].map((e) => +e.dataset.id);
  const idx = order.indexOf(id);
  t.el.remove(); tabs.delete(id);
  if (activeId === id) {
    const next = order[idx + 1] ?? order[idx - 1];
    if (next != null && tabs.has(next)) window.rave.tabSelect(next);
    else createTab();
  }
  saveSession();
});

window.rave.onTabUpdated(({ id, title, url, favicon, loading, canGoBack, canGoForward }) => {
  const t = tabs.get(id);
  if (!t) return;
  if (title !== undefined) { t.title = title; t.titleEl.textContent = isInternal(t.url) ? 'Nueva pestaña' : (title || 'Sin título'); recordHistory(t); }
  if (url !== undefined) { t.url = url; if (isInternal(url)) { t.favEl.classList.add('hidden'); t.favUrl = null; } recordHistory(t); saveSession(); }
  if (favicon !== undefined && favicon) { t.favUrl = favicon; t.favEl.src = favicon; if (!loading) t.favEl.classList.remove('hidden'); }
  if (loading !== undefined) {
    t.spinEl.classList.toggle('hidden', !loading);
    if (loading) t.favEl.classList.add('hidden'); else if (t.favUrl) t.favEl.classList.remove('hidden');
    if (id === activeId) loading ? setProgress(30) : finishProgress();
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
  // Mostrar botón lector solo en páginas no internas
  $('reader-btn').style.display = isInternal(t.url) ? 'none' : '';

  updateSplitIndicator();
  updateSplitButton();
}
function setSecurity(url) {
  if (isInternal(url) || !url) { $security.innerHTML = ''; $security.className = ''; return; }
  if (url.startsWith('https://')) { $security.innerHTML = ICONS.lock; $security.className = 'secure'; $security.title = 'Conexión segura (HTTPS)'; }
  else { $security.innerHTML = ICONS.globe; $security.className = ''; $security.title = 'Conexión no segura'; }
}

// ===== Progreso =====
let progTimer = null;
function setProgress(p) { clearTimeout(progTimer); $progress.classList.add('loading'); $progress.style.width = p + '%'; }
function finishProgress() { $progress.style.width = '100%'; progTimer = setTimeout(() => { $progress.classList.remove('loading'); $progress.style.width = '0%'; }, 300); }

// ===== Historial / sesión =====
function recordHistory(t) {
  if (INCOGNITO || isInternal(t.url)) return;
  const last = history[0];
  if (last && last.url === t.url) last.title = t.title;
  else history.unshift({ title: t.title, url: t.url, ts: Date.now() });
  if (history.length > 2000) history.length = 2000;
  store.set('history', history);
}
function saveSession() {
  if (INCOGNITO) return;
  const order = [...$tabs.querySelectorAll('.tab')].map((e) => tabs.get(+e.dataset.id)).filter(Boolean);
  const sessionData = order.map((t) => {
    const isSplit = !!t.isSplit;
    if (!isSplit && isInternal(t.url)) {
      return null;
    }
    return {
      url: t.primaryUrl || t.url || '',
      isSplit: isSplit,
      splitUrl: t.splitUrl || '',
      splitRatio: t.splitRatio || 0.5,
      activeSide: t.activeSide || 'primary'
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

// ===== Modo lector =====
$('reader-btn').addEventListener('click', async () => {
  const ok = await window.rave.injectReader();
  if (!ok) toast({ name: 'Modo lector' }, 'No disponible en esta página');
  else toast({ name: 'Modo lector activado' }, 'Vista simplificada de lectura');
});

// ===== Sugerencias =====
const $suggest = $('suggest');
let sgItems = [], sgIndex = -1;
function buildSuggestions(q) {
  const query = q.trim().toLowerCase(); const out = [];
  if (query) out.push({ type: 'search', text: `Buscar "${q.trim()}"`, url: enginePrefix() + encodeURIComponent(q.trim()) });
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
  else openPanel(a);
  updateOverlay();
});

// ===== Desplegable de extensiones =====
const $extMenu = $('ext-menu');
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
  toast({ name: 'Captura de pantalla' }, 'Capturando…');
  const dataUrl = await window.rave.capturePage();
  if (!dataUrl) { toast({ name: 'Captura' }, 'No se pudo capturar la pantalla'); return; }
  const a = document.createElement('a');
  const tab = activeTab();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `rave-screenshot-${ts}.png`;
  a.href = dataUrl;
  a.click();
  toast({ name: 'Captura guardada' }, 'La imagen se ha descargado');
}

// ===== Barra de guardar contraseña =====
const $pwBar = $('pw-save-bar');
let pwSaveData = null;
$('pw-save-yes').addEventListener('click', () => {
  if (pwSaveData) {
    const existing = passwords.findIndex((p) => p.domain === pwSaveData.domain);
    const entry = { domain: pwSaveData.domain, username: pwSaveData.username, password: xorEncrypt(pwSaveData.password), ts: Date.now() };
    if (existing >= 0) passwords[existing] = entry; else passwords.unshift(entry);
    store.set('passwords', passwords);
    toast({ name: 'Contraseña guardada' }, pwSaveData.domain);
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
  if (!history.length) return void ($panelBody.innerHTML = '<div class="empty">Historial vacío.</div>');

  // Búsqueda
  const searchWrap = document.createElement('div'); searchWrap.className = 'panel-search';
  searchWrap.innerHTML = `<span class="panel-search-ic">${ICONS.search}</span><input id="hist-search" placeholder="Buscar en historial…" />`;
  $panelBody.appendChild(searchWrap);
  const listContainer = document.createElement('div'); listContainer.id = 'hist-list'; $panelBody.appendChild(listContainer);

  const renderList = (filter = '') => {
    listContainer.innerHTML = '';
    const filtered = filter ? history.filter((h) => (h.url + h.title).toLowerCase().includes(filter.toLowerCase())) : history;
    if (!filtered.length) { listContainer.innerHTML = '<div class="empty">Sin resultados.</div>'; return; }
    filtered.forEach((h, i) => listContainer.appendChild(listRow(h, () => act('navigate', h.url),
      () => { history.splice(history.indexOf(h), 1); store.set('history', history); renderList(filter); })));
  };
  renderList();
  $('hist-search').addEventListener('input', (e) => renderList(e.target.value));

  const a = document.createElement('div'); a.className = 'panel-actions';
  a.innerHTML = `<button class="btn ghost" id="hist-export">${ICONS.export} Exportar</button><button class="btn ghost" id="hist-clear">Borrar todo</button>`;
  $panelBody.appendChild(a);
  $('hist-export').addEventListener('click', () => downloadJSON(history, 'rave-history.json'));
  $('hist-clear').addEventListener('click', () => { history = []; store.set('history', history); renderHistoryPanel(); });
}

// ===== Panel: Descargas =====
function renderDownloadsPanel() {
  $panelTitle.textContent = 'Descargas'; $panelBody.innerHTML = '';
  if (!downloads.length) return void ($panelBody.innerHTML = '<div class="empty">No hay descargas.</div>');
  downloads.forEach((d) => {
    const row = document.createElement('div'); row.className = 'row';
    const stateIcon = d.state === 'completed' ? ICONS.download : d.state === 'cancelled' ? ICONS.close : ICONS.reload;
    const stateLabel = d.state === 'completed' ? 'Completada' : d.state === 'cancelled' ? 'Cancelada' : 'En curso…';
    row.innerHTML = `<span class="row-icon">${stateIcon}</span><div class="r-main"><div class="r-title"></div><div class="r-url">${stateLabel}</div></div><button class="r-del">${ICONS.trash}</button>`;
    row.querySelector('.r-title').textContent = d.name;
    row.querySelector('.r-del').addEventListener('click', () => { downloads.splice(downloads.indexOf(d), 1); store.set('downloads', downloads); renderDownloadsPanel(); });
    $panelBody.appendChild(row);
  });
  const a = document.createElement('div'); a.className = 'panel-actions';
  a.innerHTML = '<button class="btn ghost">Limpiar lista</button>';
  a.querySelector('button').addEventListener('click', () => { downloads = []; store.set('downloads', downloads); renderDownloadsPanel(); });
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
  $('pw-new-save').addEventListener('click', () => {
    const domain = $('pw-new-domain').value.trim().replace(/^https?:\/\//, '').split('/')[0];
    const username = $('pw-new-user').value.trim();
    const password = $('pw-new-pass').value;
    if (!domain || !username || !password) { alert('Completa todos los campos.'); return; }
    const existing = passwords.findIndex((p) => p.domain === domain && p.username === username);
    const entry = { domain, username, password: xorEncrypt(password), ts: Date.now() };
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
          <button class="pw-del" title="Eliminar">${ICONS.trash}</button>
        </div>`;
      row.querySelector('.pw-domain span').textContent = p.domain;
      row.querySelector('.pw-user span').textContent = p.username;
      row.querySelector('.pw-copy-user').addEventListener('click', () => { window.rave.copyText(p.username); toast({ name: 'Usuario copiado' }, p.domain); });
      row.querySelector('.pw-copy-pass').addEventListener('click', () => { window.rave.copyText(xorDecrypt(p.password)); toast({ name: 'Contraseña copiada' }, p.domain); });
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
  $('pw-export').addEventListener('click', () => {
    const csv = ['Dominio,Usuario,Contraseña', ...passwords.map((p) => `${p.domain},${p.username},${xorDecrypt(p.password)}`)].join('\n');
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

// ===== Panel: Ajustes =====
function renderSettingsPanel() {
  $panelTitle.textContent = 'Ajustes';
  const eng = Object.entries(ENGINES).map(([k, v]) => `<option value="${k}" ${settings.engine === k ? 'selected' : ''}>${v.name}</option>`).join('');
  const th = (v, l) => `<option value="${v}" ${settings.theme === v ? 'selected' : ''}>${l}</option>`;
  const rf = (v, l) => `<option value="${v}" ${settings.readerFont === v ? 'selected' : ''}>${l}</option>`;
  const chk = (k, id) => `<input type="checkbox" id="${id}" style="width:auto;height:auto" ${settings[k] ? 'checked' : ''} />`;
  $panelBody.innerHTML = `
    <div class="settings-section">Búsqueda</div>
    <div class="set-row"><label>Motor de búsqueda</label><select id="s-engine">${eng}</select></div>
    <div class="set-row"><label>Página de inicio <small style="color:var(--ink-soft)">(vacío = nueva pestaña)</small></label><input id="s-home" placeholder="https://…" value="${settings.homepage || ''}" /></div>

    <div class="settings-section">Apariencia</div>
    <div class="set-row"><label>Tema</label><select id="s-theme">${th('system', 'Sistema')}${th('light', 'Claro')}${th('dark', 'Oscuro')}</select></div>
    <div class="set-row set-row-check"><label for="s-bar">Mostrar barra de marcadores</label>${chk('showBookmarksBar', 's-bar')}</div>
    <div class="set-row set-row-check"><label for="s-anim">Animaciones</label>${chk('animations', 's-anim')}</div>
    <div class="set-row"><label>Fuente del modo lector</label><select id="s-rf">${rf('serif', 'Serif (Georgia)')}${rf('sans', 'Sans-serif (system)')}</select></div>

    <div class="settings-section">Privacidad</div>
    <div class="set-row set-row-check"><label for="s-pw">Ofrecer guardar contraseñas</label>${chk('savePasswords', 's-pw')}</div>

    <div class="settings-section">Datos</div>
    <div class="set-row" style="flex-direction:row;gap:8px;flex-wrap:wrap">
      <button class="btn ghost" id="s-exp-hist">${ICONS.export} Exportar historial</button>
      <button class="btn ghost" id="s-exp-bm">${ICONS.export} Exportar marcadores</button>
      <label class="btn ghost" style="cursor:pointer">${ICONS.import_} Importar marcadores<input type="file" id="s-imp-bm" accept=".json" style="display:none"></label>
    </div>
    <div class="set-row">
      <button class="btn" id="s-clear-data" style="background:#c0392b">Borrar todos los datos del navegador</button>
    </div>

    <div class="set-row" style="flex-direction:row;gap:8px;margin-top:8px">
      <button class="btn" id="s-save">Guardar ajustes</button>
    </div>`;

  $('s-save').addEventListener('click', () => {
    settings = {
      engine: $('s-engine').value, homepage: $('s-home').value.trim(),
      theme: $('s-theme').value, showBookmarksBar: $('s-bar').checked,
      animations: $('s-anim').checked, readerFont: $('s-rf').value,
      savePasswords: $('s-pw').checked
    };
    store.set('settings', settings); applyTheme(); applyAnimations();
    renderBookmarksBar();
    $panel.classList.add('hidden'); updateOverlay();
    toast({ name: 'Ajustes guardados' }, '');
  });
  $('s-exp-hist').addEventListener('click', () => downloadJSON(history, 'rave-history.json'));
  $('s-exp-bm').addEventListener('click', () => downloadJSON(bookmarks, 'rave-bookmarks.json'));
  $('s-imp-bm').addEventListener('change', async (e) => {
    const text = await e.target.files[0]?.text();
    if (!text) return;
    try { const data = JSON.parse(text); if (Array.isArray(data)) { bookmarks = data; store.set('bookmarks', bookmarks); renderBookmarksBar(); toast({ name: 'Marcadores importados' }, data.length + ' marcadores'); } } catch { alert('Archivo inválido.'); }
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

// ===== Utilidades =====
function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
}

// ===== Descargas =====
function toast(d, sub) {
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = `<span class="t-ic">${ICONS.download}</span><div class="t-body"><div class="t-title"></div><div class="t-sub"></div></div>`;
  el.querySelector('.t-title').textContent = d.name; el.querySelector('.t-sub').textContent = sub;
  $('toasts').appendChild(el); setTimeout(() => el.remove(), 4000);
}
window.rave.onDownloadStarted((d) => {
  if (!INCOGNITO) { downloads.unshift({ name: d.name, state: 'progressing', ts: Date.now() }); store.set('downloads', downloads); }
  toast(d, 'Descargando…');
});
window.rave.onDownloadDone((d) => {
  if (!INCOGNITO) { const r = downloads.find((x) => x.name === d.name && x.state === 'progressing'); if (r) { r.state = d.state; store.set('downloads', downloads); } }
  toast(d, d.state === 'completed' ? 'Descarga completada' : 'Descarga ' + d.state);
});

// ===== Actualizaciones OTA =====
let updateToast = null;
window.rave.onUpdate((u) => {
  if (u.state === 'available') toast({ name: 'Rave ' + u.version }, 'Actualización disponible, descargando…');
  else if (u.state === 'downloaded') {
    if (updateToast) updateToast.remove();
    updateToast = document.createElement('div');
    updateToast.className = 'toast';
    updateToast.innerHTML = `<span class="t-ic">${ICONS.download}</span>
      <div class="t-body"><div class="t-title">Actualización lista (${u.version})</div>
      <div class="t-sub">Reinicia para instalarla</div></div>
      <button class="btn" style="height:28px">Reiniciar</button>`;
    updateToast.querySelector('button').addEventListener('click', () => window.rave.updateInstall());
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
let $ctx = null;
function closeCtx() { if ($ctx) { $ctx.remove(); $ctx = null; updateOverlay(); } }
document.addEventListener('click', closeCtx);
window.rave.onContextMenu(({ id, p }) => {
  if (id !== activeId) return;
  const x = p.x, y = measureLayout() + p.y;
  const items = [];
  if (p.linkURL) items.push(
    { label: 'Abrir enlace en pestaña nueva', action: () => createTab(p.linkURL) },
    { label: 'Copiar dirección del enlace', action: () => window.rave.copyText(p.linkURL) }, 'sep');
  if (p.srcURL && p.mediaType === 'image') items.push(
    { label: 'Copiar dirección de la imagen', action: () => window.rave.copyText(p.srcURL) }, 'sep');
  if (p.selectionText) items.push(
    { label: 'Copiar', action: () => act('copy') },
    { label: `Buscar "${p.selectionText.slice(0, 20)}${p.selectionText.length > 20 ? '…' : ''}"`, action: () => createTab(enginePrefix() + encodeURIComponent(p.selectionText)) }, 'sep');
  if (p.isEditable) items.push(
    { label: 'Cortar', action: () => act('cut'), disabled: !p.selectionText },
    { label: 'Copiar', action: () => act('copy'), disabled: !p.selectionText },
    { label: 'Pegar', action: () => act('paste') }, 'sep');
  const t = activeTab();
  items.push(
    { label: 'Atrás', action: () => act('back'), disabled: !t?.back },
    { label: 'Adelante', action: () => act('forward'), disabled: !t?.fwd },
    { label: 'Recargar', action: () => act('reload') }, 'sep',
    { label: 'Captura de pantalla', action: () => doCapture() }, 'sep',
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

// ===== Disposición / overlay =====
function measureLayout() {
  const h = $('chrome').offsetHeight + ($('pw-save-bar').classList.contains('hidden') ? 0 : $('pw-save-bar').offsetHeight);
  window.rave.setLayout(h);
  return h;
}
function updateOverlay() {
  const on = !$menu.classList.contains('hidden') || !$panel.classList.contains('hidden') ||
    !$suggest.classList.contains('hidden') || !$extMenu.classList.contains('hidden') ||
    !$shieldMenu.classList.contains('hidden') || !!$ctx;
  window.rave.setOverlay(on);
}
new ResizeObserver(measureLayout).observe($('chrome'));
window.addEventListener('resize', measureLayout);

// ===== Controles de ventana =====
const $winMax = $('win-max');
$('win-min').addEventListener('click', () => window.rave.winMinimize());
$winMax.addEventListener('click', () => window.rave.winMaximize());
$('win-close').addEventListener('click', () => window.rave.winClose());
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
  else if (c && k === 'p') { e.preventDefault(); openPanel('passwords'); }
  else if (c && (k === '+' || k === '=')) { e.preventDefault(); applyZoom(0.1); }
  else if (c && k === '-') { e.preventDefault(); applyZoom(-0.1); }
  else if (c && k === '0') { e.preventDefault(); applyZoom(0, 1); }
  else if (k === 'escape') closeFind();
});

// ===== Escudo =====
setInterval(async () => {
  try {
    const count = await window.rave.getBlockedCount();
    $('shield-count').textContent = count;
    const menuCount = $('shield-menu-count');
    if (menuCount) menuCount.textContent = count;
  } catch {}
}, 1000);

// ===== Arranque =====
applyTheme();
applyAnimations();
renderBookmarksBar();
measureLayout();
// Iconos en botones del menú (recargamos tras crear el HTML)
document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = ICONS[el.dataset.icon] || ''; });
const saved = INCOGNITO ? [] : store.get('session', []);
if (saved.length) {
  saved.forEach((item) => {
    if (typeof item === 'string') {
      createTab(item);
    } else if (item && typeof item === 'object') {
      createTab(item.url).then((id) => {
        if (id && item.isSplit) {
          window.rave.tabSplitToggle(id, item.splitUrl, item.splitRatio, item.activeSide);
        }
      });
    }
  });
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

window.rave.onTabSplitState(({ id, isSplit, activeSide }) => {
  const t = tabs.get(id);
  if (!t) return;
  t.isSplit = isSplit;
  t.activeSide = activeSide;
  if (!isSplit) {
    t.primaryUrl = null;
    t.splitUrl = null;
    t.splitRatio = null;
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

