// Actualizaciones OTA de Rave (escritorio) con electron-updater.
//
// Requiere que la app esté EMPAQUETADA y que publiques los archivos generados
// por electron-builder (latest.yml + el instalador) en el host indicado en
// package.json -> build.publish.url. En desarrollo (no empaquetado) se omite.

const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

let broadcastFn = null;

function setupUpdater(broadcast) {
  broadcastFn = broadcast;
  if (!app.isPackaged) {
    console.log('[Rave] Updater desactivado en desarrollo (app no empaquetada).');
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (i) => broadcast('rave:update', { state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', (i) => broadcast('rave:update', { state: 'not-available', version: i.version }));
  autoUpdater.on('download-progress', (p) => broadcast('rave:update', { state: 'progress', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => broadcast('rave:update', { state: 'downloaded', version: i.version }));
  autoUpdater.on('error', (e) => broadcast('rave:update', { state: 'error', message: String(e && e.message || e) }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000);   // cada 6 horas
}

function checkNow() {
  if (!app.isPackaged) {
    if (broadcastFn) {
      broadcastFn('rave:update', { state: 'error', message: 'El actualizador no funciona en desarrollo (app no empaquetada).' });
    }
    return;
  }
  autoUpdater.checkForUpdates().catch(() => {});
}

function quitAndInstall() { autoUpdater.quitAndInstall(); }

module.exports = { setupUpdater, checkNow, quitAndInstall };
