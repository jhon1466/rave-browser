const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const HISTORY_FILE = () => path.join(app.getPath('userData'), 'history.json');
const MAX_ENTRIES = 5000;

let _history = null;

function loadHistory() {
  if (_history) return _history;
  try { _history = JSON.parse(fs.readFileSync(HISTORY_FILE(), 'utf8')); }
  catch { _history = []; }
  return _history;
}

function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE(), JSON.stringify(_history)); } catch {}
}

function addHistory(url, title, favIconUrl) {
  if (!url || url.startsWith('about:') || url.startsWith('file:')) return;
  const data = loadHistory();
  const now = Date.now();
  if (data.length && data[0].url === url && now - data[0].ts < 30000) {
    if (title) data[0].title = title;
    if (favIconUrl) data[0].favicon = favIconUrl;
    saveHistory();
    return;
  }
  data.unshift({ url, title: title || url, favicon: favIconUrl || '', ts: now });
  if (data.length > MAX_ENTRIES) data.length = MAX_ENTRIES;
  _history = data;
  saveHistory();
}

function searchHistory(query, limit = 100) {
  const data = loadHistory();
  if (!query) return data.slice(0, limit);
  const q = query.toLowerCase();
  return data.filter(e => e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q)).slice(0, limit);
}

function clearHistory() {
  _history = [];
  saveHistory();
}

function deleteEntry(url, ts) {
  const data = loadHistory();
  _history = data.filter(e => !(e.url === url && e.ts === ts));
  saveHistory();
}

function registerHistoryIPC() {
  ipcMain.handle('rave:history-search', (_e, query) => searchHistory(query));
  ipcMain.handle('rave:history-clear', () => clearHistory());
  ipcMain.handle('rave:history-delete', (_e, { url, ts }) => deleteEntry(url, ts));
}

module.exports = { addHistory, searchHistory, clearHistory, registerHistoryIPC };
