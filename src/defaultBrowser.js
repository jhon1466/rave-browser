// Navegador predeterminado del sistema (http/https).
const { app, shell } = require('electron');
const { execFile, exec } = require('child_process');
const path = require('path');

function isDefaultBrowser() {
  try {
    return app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https');
  } catch {
    return false;
  }
}

// Registra las claves de registro necesarias para que Windows muestre Rave
// en "Aplicaciones predeterminadas" → sección Navegador web.
function registerWindowsCapabilities() {
  if (process.platform !== 'win32' || !app.isPackaged) return;

  const exe = `"${process.execPath}"`;
  const entries = [
    // ProgID
    ['HKCU\\Software\\Classes\\RaveBrowser', '', 'Rave Browser Document'],
    ['HKCU\\Software\\Classes\\RaveBrowser\\Application', 'ApplicationName', 'Rave'],
    ['HKCU\\Software\\Classes\\RaveBrowser\\Application', 'AppUserModelId', 'com.rave.browser'],
    [`HKCU\\Software\\Classes\\RaveBrowser\\DefaultIcon`, '', `${process.execPath},0`],
    [`HKCU\\Software\\Classes\\RaveBrowser\\shell\\open\\command`, '', `${exe} "%1"`],
    // Capabilities
    ['HKCU\\Software\\Rave\\Capabilities', 'ApplicationName', 'Rave'],
    ['HKCU\\Software\\Rave\\Capabilities', 'ApplicationDescription', 'Navegador web rápido y minimalista'],
    ['HKCU\\Software\\Rave\\Capabilities\\FileAssociations', '.htm',   'RaveBrowser'],
    ['HKCU\\Software\\Rave\\Capabilities\\FileAssociations', '.html',  'RaveBrowser'],
    ['HKCU\\Software\\Rave\\Capabilities\\FileAssociations', '.xhtml', 'RaveBrowser'],
    ['HKCU\\Software\\Rave\\Capabilities\\URLAssociations',  'http',   'RaveBrowser'],
    ['HKCU\\Software\\Rave\\Capabilities\\URLAssociations',  'https',  'RaveBrowser'],
    ['HKCU\\Software\\Rave\\Capabilities\\URLAssociations',  'ftp',    'RaveBrowser'],
    // Registro global
    ['HKCU\\Software\\RegisteredApplications', 'Rave', 'Software\\Rave\\Capabilities'],
  ];

  for (const [key, name, value] of entries) {
    try {
      if (name) {
        require('child_process').execFileSync('reg', ['add', key, '/v', name, '/d', value, '/f']);
      } else {
        require('child_process').execFileSync('reg', ['add', key, '/ve', '/d', value, '/f']);
      }
    } catch { /* ignora errores individuales */ }
  }

  // Notificar a Windows del cambio
  try {
    exec('powershell -NoProfile -Command "[System.Environment]::SetEnvironmentVariable(\'PATHEXT\',$env:PATHEXT,[System.EnvironmentVariableTarget]::User)"');
  } catch { }
}

async function openDefaultBrowserSettings() {
  if (process.platform === 'win32') {
    await shell.openExternal('ms-settings:defaultapps');
    return;
  }
  if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.general');
    return;
  }
  if (process.platform === 'linux') {
    await new Promise((resolve) => {
      execFile('xdg-open', ['x-scheme-handler/http'], () => resolve());
    });
  }
}

async function setDefaultBrowser() {
  if (!app.isPackaged) {
    await openDefaultBrowserSettings();
    return { ok: false, openedSettings: true, dev: true };
  }

  // Registrar en el sistema primero
  registerWindowsCapabilities();
  app.setAsDefaultProtocolClient('http');
  app.setAsDefaultProtocolClient('https');
  app.setAsDefaultProtocolClient('ftp');

  if (isDefaultBrowser()) return { ok: true, openedSettings: false };

  // Si no se pudo establecer automáticamente, abrir configuración de Windows
  await openDefaultBrowserSettings();
  return { ok: isDefaultBrowser(), openedSettings: true };
}

module.exports = { isDefaultBrowser, setDefaultBrowser };
