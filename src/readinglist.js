const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const RL_FILE = () => path.join(app.getPath('userData'), 'readinglist.json');

let _list = null;

function loadList() {
  if (_list) return _list;
  try { _list = JSON.parse(fs.readFileSync(RL_FILE(), 'utf8')); }
  catch { _list = []; }
  return _list;
}

function saveList() {
  try { fs.writeFileSync(RL_FILE(), JSON.stringify(_list)); } catch {}
}

function addToReadingList(url, title, favicon) {
  if (!url || url.startsWith('about:')) return false;
  const list = loadList();
  if (list.find((e) => e.url === url)) return false; // ya existe
  list.unshift({ url, title: title || url, favicon: favicon || '', ts: Date.now() });
  if (list.length > 500) list.length = 500;
  saveList();
  return true;
}

function getReadingList() { return loadList(); }

function deleteFromReadingList(url) {
  const list = loadList();
  const idx = list.findIndex((e) => e.url === url);
  if (idx !== -1) { list.splice(idx, 1); saveList(); }
}

function clearReadingList() { _list = []; saveList(); }

function registerReadingListIPC() {
  ipcMain.handle('rave:rl-get', () => getReadingList());
  ipcMain.handle('rave:rl-add', (_e, { url, title, favicon }) => addToReadingList(url, title, favicon));
  ipcMain.handle('rave:rl-delete', (_e, url) => deleteFromReadingList(url));
  ipcMain.handle('rave:rl-clear', () => clearReadingList());
}

module.exports = { addToReadingList, getReadingList, deleteFromReadingList, registerReadingListIPC };
