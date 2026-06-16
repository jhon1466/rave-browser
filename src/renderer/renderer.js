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
const ENGINES = {
  ddg:    { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  google: { name: 'Google',     url: 'https://www.google.com/search?q=' },
  bing:   { name: 'Bing',       url: 'https://www.bing.com/search?q=' }
};
let settings = store.get('settings', { engine: 'ddg', homepage: '', theme: 'system' });
let bookmarks = store.get('bookmarks', []);
let history = INCOGNITO ? [] : store.get('history', []);
let downloads = INCOGNITO ? [] : store.get('downloads', []);
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

// ===== Estado de pestañas (espejo de lo que vive en el proceso principal) =====
const tabs = new Map();   // id -> { el, favEl, spinEl, titleEl, title, url, zoom, back, fwd }
let activeId = null;

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

// Tamaño real de la ventana (la vista de interfaz mide solo el chrome).
let winW = window.innerWidth, winH = window.innerHeight;
window.rave.onViewSize(({ w, h }) => { winW = w; winH = h; });

// ===== Comandos hacia el proceso principal =====
function createTab(url) { window.rave.tabCreate(url || newTabURL()); }   // el main responde con 'tab-opened'
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
  el.addEventListener('dragstart', () => el.classList.add('dragging'));
  el.addEventListener('dragend', () => { el.classList.remove('dragging'); syncTabOrder(); });
  tabs.set(id, {
    el, title: 'Nueva pestaña', url, zoom: 1, back: false, fwd: false,
    favEl: el.querySelector('.favicon'), spinEl: el.querySelector('.spinner'), titleEl: el.querySelector('.title')
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
  store.set('session', order.filter((t) => !isInternal(t.url)).map((t) => t.url));
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

// ===== Sugerencias =====
const $suggest = $('suggest');
let sgItems = [], sgIndex = -1;
function buildSuggestions(q) {
  const query = q.trim().toLowerCase(); const out = [];
  if (query) out.push({ type: 'search', text: `Buscar “${q.trim()}”`, url: enginePrefix() + encodeURIComponent(q.trim()) });
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

// ===== Panel overlay =====
const $panel = $('panel'), $panelTitle = $('panel-title'), $panelBody = $('panel-body');
$('panel-close').addEventListener('click', () => { $panel.classList.add('hidden'); updateOverlay(); });
$panel.addEventListener('click', (e) => { if (e.target === $panel) { $panel.classList.add('hidden'); updateOverlay(); } });
function openPanel(which) {
  ({ bookmarks: renderBookmarksPanel, history: renderHistoryPanel, downloads: renderDownloadsPanel, extensions: renderExtensionsPanel, settings: renderSettingsPanel }[which])();
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
function renderBookmarksPanel() {
  $panelTitle.textContent = 'Marcadores'; $panelBody.innerHTML = '';
  if (!bookmarks.length) return void ($panelBody.innerHTML = '<div class="empty">Aún no tienes marcadores. Pulsa la estrella en la barra de direcciones.</div>');
  bookmarks.forEach((b, i) => $panelBody.appendChild(listRow(b, () => act('navigate', b.url),
    () => { bookmarks.splice(i, 1); store.set('bookmarks', bookmarks); renderBookmarksBar(); updateChrome(); renderBookmarksPanel(); })));
}
function renderHistoryPanel() {
  $panelTitle.textContent = 'Historial'; $panelBody.innerHTML = '';
  if (INCOGNITO) return void ($panelBody.innerHTML = '<div class="empty">En modo incógnito no se guarda historial.</div>');
  if (!history.length) return void ($panelBody.innerHTML = '<div class="empty">Historial vacío.</div>');
  history.forEach((h, i) => $panelBody.appendChild(listRow(h, () => act('navigate', h.url),
    () => { history.splice(i, 1); store.set('history', history); renderHistoryPanel(); })));
  const a = document.createElement('div'); a.className = 'panel-actions';
  a.innerHTML = '<button class="btn ghost">Borrar todo el historial</button>';
  a.querySelector('button').addEventListener('click', () => { history = []; store.set('history', history); renderHistoryPanel(); });
  $panelBody.appendChild(a);
}
function renderDownloadsPanel() {
  $panelTitle.textContent = 'Descargas'; $panelBody.innerHTML = '';
  if (!downloads.length) return void ($panelBody.innerHTML = '<div class="empty">No hay descargas.</div>');
  downloads.forEach((d) => {
    const row = document.createElement('div'); row.className = 'row';
    const sub = d.state === 'completed' ? 'Completada' : d.state === 'cancelled' ? 'Cancelada' : 'En curso…';
    row.innerHTML = `<div class="r-main"><div class="r-title"></div><div class="r-url">${sub}</div></div>`;
    row.querySelector('.r-title').textContent = d.name; $panelBody.appendChild(row);
  });
}
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
    row.innerHTML = `<div class="r-main"><div class="r-title"></div><div class="r-url"></div></div>`;
    row.querySelector('.r-title').textContent = x.name;
    row.querySelector('.r-url').textContent = 'v' + x.version;
    $panelBody.appendChild(row);
  });
  const a = document.createElement('div'); a.className = 'panel-actions';
  a.innerHTML = '<button class="btn">Abrir carpeta de extensiones</button>';
  a.querySelector('button').addEventListener('click', () => window.rave.openExtensionsFolder());
  $panelBody.appendChild(a);
}
function renderSettingsPanel() {
  $panelTitle.textContent = 'Ajustes';
  const eng = Object.entries(ENGINES).map(([k, v]) => `<option value="${k}" ${settings.engine === k ? 'selected' : ''}>${v.name}</option>`).join('');
  const th = (v, l) => `<option value="${v}" ${settings.theme === v ? 'selected' : ''}>${l}</option>`;
  $panelBody.innerHTML = `
    <div class="set-row"><label>Buscador predeterminado</label><select id="s-engine">${eng}</select></div>
    <div class="set-row"><label>Página de inicio (vacío = nueva pestaña de Rave)</label><input id="s-home" placeholder="https://..." value="${settings.homepage || ''}" /></div>
    <div class="set-row"><label>Tema</label><select id="s-theme">${th('system', 'Sistema')}${th('light', 'Claro')}${th('dark', 'Oscuro')}</select></div>
    <div class="set-row" style="flex-direction:row;gap:8px;"><button class="btn" id="s-save">Guardar</button></div>`;
  $('s-save').addEventListener('click', () => {
    settings = { engine: $('s-engine').value, homepage: $('s-home').value.trim(), theme: $('s-theme').value };
    store.set('settings', settings); applyTheme(); $panel.classList.add('hidden'); updateOverlay();
  });
}
function applyTheme() {
  if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', settings.theme);
}

// ===== Descargas =====
function toast(d, sub) {
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = `<span class="t-ic">${ICONS.download}</span><div class="t-body"><div class="t-title"></div><div class="t-sub"></div></div>`;
  el.querySelector('.t-title').textContent = d.name; el.querySelector('.t-sub').textContent = sub;
  $('toasts').appendChild(el); setTimeout(() => el.remove(), 5000);
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
    // Aviso persistente con botón para reiniciar e instalar.
    if (updateToast) updateToast.remove();
    updateToast = document.createElement('div');
    updateToast.className = 'toast';
    updateToast.innerHTML = `<span class="t-ic">${ICONS.download}</span>
      <div class="t-body"><div class="t-title">Actualización lista (${u.version})</div>
      <div class="t-sub">Reinicia para instalarla</div></div>
      <button class="btn" style="height:28px">Reiniciar</button>`;
    updateToast.querySelector('button').addEventListener('click', () => window.rave.updateInstall());
    $('toasts').appendChild(updateToast);
  } else if (u.state === 'error') {
    toast({ name: 'Actualizaciones' }, 'Sin actualizaciones o error de red');
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

// ===== Menú contextual (clic derecho sobre la página) =====
let $ctx = null;
function closeCtx() { if ($ctx) { $ctx.remove(); $ctx = null; updateOverlay(); } }
document.addEventListener('click', closeCtx);
window.rave.onContextMenu(({ id, p }) => {
  if (id !== activeId) return;
  const x = p.x, y = measureLayout() + p.y;   // la página empieza tras el chrome
  const items = [];
  if (p.linkURL) items.push(
    { label: 'Abrir enlace en pestaña nueva', action: () => createTab(p.linkURL) },
    { label: 'Copiar dirección del enlace', action: () => window.rave.copyText(p.linkURL) }, 'sep');
  if (p.srcURL && p.mediaType === 'image') items.push(
    { label: 'Copiar dirección de la imagen', action: () => window.rave.copyText(p.srcURL) }, 'sep');
  if (p.selectionText) items.push(
    { label: 'Copiar', action: () => act('copy') },
    { label: `Buscar “${p.selectionText.slice(0, 20)}${p.selectionText.length > 20 ? '…' : ''}”`, action: () => createTab(enginePrefix() + encodeURIComponent(p.selectionText)) }, 'sep');
  if (p.isEditable) items.push(
    { label: 'Cortar', action: () => act('cut'), disabled: !p.selectionText },
    { label: 'Copiar', action: () => act('copy'), disabled: !p.selectionText },
    { label: 'Pegar', action: () => act('paste') }, 'sep');
  const t = activeTab();
  items.push(
    { label: 'Atrás', action: () => act('back'), disabled: !t?.back },
    { label: 'Adelante', action: () => act('forward'), disabled: !t?.fwd },
    { label: 'Recargar', action: () => act('reload') }, 'sep',
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
  // Usamos el tamaño REAL de la ventana, no innerHeight (que es solo el chrome).
  $ctx.style.left = Math.max(4, Math.min(x, winW - r.width - 8)) + 'px';
  $ctx.style.top = Math.max(4, Math.min(y, winH - r.height - 8)) + 'px';
}

// ===== Disposición / overlay =====
function measureLayout() {
  const h = $('chrome').offsetHeight;
  window.rave.setLayout(h);
  return h;
}
function updateOverlay() {
  const on = !$menu.classList.contains('hidden') || !$panel.classList.contains('hidden') ||
    !$suggest.classList.contains('hidden') || !$extMenu.classList.contains('hidden') || !!$ctx;
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
  else if (c && (k === '+' || k === '=')) { e.preventDefault(); applyZoom(0.1); }
  else if (c && k === '-') { e.preventDefault(); applyZoom(-0.1); }
  else if (c && k === '0') { e.preventDefault(); applyZoom(0, 1); }
  else if (k === 'escape') closeFind();
});

// ===== Escudo =====
setInterval(async () => { try { $('shield-count').textContent = await window.rave.getBlockedCount(); } catch {} }, 1000);

// ===== Arranque =====
applyTheme();
renderBookmarksBar();
measureLayout();
const saved = INCOGNITO ? [] : store.get('session', []);
if (saved.length) saved.forEach((u) => createTab(u));
else createTab();
