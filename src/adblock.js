// Bloqueo de anuncios y rastreadores nivel uBlock Origin.
//
// Usa @ghostery/adblocker-electron, que consume EXACTAMENTE las mismas listas
// de filtros que uBlock Origin (EasyList, EasyPrivacy, las propias de uBO, etc.)
// y se engancha a la sesión de Electron para cancelar peticiones y aplicar
// cosmetic filtering (ocultar huecos de anuncios) en los <webview>.
//
// La primera vez descarga las listas y las cachea en disco para los arranques
// siguientes (más rápido y funciona offline).

const path = require('path');
const fs = require('fs');
const { app, ipcMain } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const fetch = require('cross-fetch');

// Interceptar ipcMain.handle para evitar errores al activar el adblocker
// en múltiples sesiones (como el modo incógnito).
const originalHandle = ipcMain.handle;
ipcMain.handle = function(channel, listener) {
  try {
    originalHandle.call(ipcMain, channel, listener);
  } catch (err) {
    if (err && err.message && err.message.includes('Attempted to register a second handler')) {
      console.warn(`[Rave] Handler para el canal "${channel}" ya estaba registrado. Omitiendo.`);
    } else {
      throw err;
    }
  }
};

// v2: ahora cargamos las listas COMPLETAS de uBlock Origin (incluidas las que
// neutralizan los anuncios de YouTube mediante scriptlets +js).
const CACHE_FILE = () => path.join(app.getPath('userData'), 'rave-adblock-engine-v2.bin');

// Listas de filtros. Mezclamos EasyList/EasyPrivacy con las propias de uBO,
// que son las que contienen las reglas específicas de YouTube.
const FILTER_LISTS = [
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
  // uBlock Origin (uAssets) — aquí viven los scriptlets de YouTube:
  'https://ublockorigin.github.io/uAssets/filters/filters.txt',
  'https://ublockorigin.github.io/uAssets/filters/filters-2020.txt',
  'https://ublockorigin.github.io/uAssets/filters/filters-2021.txt',
  'https://ublockorigin.github.io/uAssets/filters/filters-2022.txt',
  'https://ublockorigin.github.io/uAssets/filters/filters-2023.txt',
  'https://ublockorigin.github.io/uAssets/filters/filters-2024.txt',
  'https://ublockorigin.github.io/uAssets/filters/filters-2025.txt',
  'https://ublockorigin.github.io/uAssets/filters/privacy.txt',
  'https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt',
  'https://ublockorigin.github.io/uAssets/filters/unbreak.txt',
  'https://ublockorigin.github.io/uAssets/filters/badware.txt',
  'https://ublockorigin.github.io/uAssets/filters/resource-abuse.txt'
];

async function setupAdblock(ses) {
  global.__raveBlockedCount = 0;

  const cachePath = CACHE_FILE();

  // Persistencia del motor: lee/escribe el engine serializado en userData.
  const caching = {
    path: cachePath,
    read: async () => fs.promises.readFile(cachePath),
    write: async (data) => fs.promises.writeFile(cachePath, data)
  };

  let blocker;
  try {
    // Construye el motor desde las listas completas de uBO + EasyList.
    // enableHtmlFiltering/scriptlets van activados por defecto en el engine.
    blocker = await ElectronBlocker.fromLists(fetch, FILTER_LISTS, {
      enableCompression: true,
      loadCosmeticFilters: false,   // Desactivado: causa RangeError en SPAs complejas (ChatGPT, etc.)
      loadNetworkFilters: true
    }, caching);
  } catch (err) {
    console.error('[Rave] No se pudieron cargar las listas de uBlock:', err.message);
    return; // Sin red la primera vez: el navegador sigue funcionando, sin bloqueo.
  }

  // Guarda el motor para reusarlo en otras sesiones (p. ej. incógnito).
  global.__raveBlocker = blocker;

  // Contador para el "escudo" de la barra.
  blocker.on('request-blocked', () => { global.__raveBlockedCount++; });
  blocker.on('request-redirected', () => { global.__raveBlockedCount++; });

  // Activa bloqueo de red + cosmetic filtering sobre esta sesión.
  blocker.enableBlockingInSession(ses);

  console.log('[Rave] uBlock activado (listas completas uBO + EasyList, scriptlets YouTube).');
  return blocker;
}

// Activa el bloqueo en una sesión adicional (incógnito) si el motor ya cargó.
function enableBlockingOn(ses) {
  if (global.__raveBlocker) global.__raveBlocker.enableBlockingInSession(ses);
}

module.exports = { setupAdblock, enableBlockingOn };
