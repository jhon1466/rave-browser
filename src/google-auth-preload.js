// Preload para la ventana de inicio de sesión de Google.
// Corre en el MUNDO REAL de la página (contextIsolation:false) ANTES de que se
// ejecute cualquier script de Google, sin usar el depurador/CDP (que Google
// detecta como "software automatizado"). Limpia las señales que delatan Electron.

(() => {
  const CHROME_VERSION = '136.0.0.0';
  const MAJOR = CHROME_VERSION.split('.')[0];

  // 1) navigator.webdriver = false
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => false, configurable: true
    });
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false, configurable: true
    });
  } catch (e) {}

  // 2) navigator.userAgentData con la marca "Google Chrome"
  try {
    const brands = [
      { brand: 'Chromium', version: MAJOR },
      { brand: 'Google Chrome', version: MAJOR },
      { brand: 'Not/A)Brand', version: '8' }
    ];
    const fullVersionList = [
      { brand: 'Chromium', version: CHROME_VERSION },
      { brand: 'Google Chrome', version: CHROME_VERSION },
      { brand: 'Not/A)Brand', version: '8.0.0.0' }
    ];
    const uaData = {
      brands,
      mobile: false,
      platform: 'Windows',
      getHighEntropyValues: () => Promise.resolve({
        architecture: 'x86', bitness: '64', brands, fullVersionList,
        mobile: false, model: '', platform: 'Windows',
        platformVersion: '15.0.0', uaFullVersion: CHROME_VERSION, wow64: false
      }),
      toJSON: () => ({ brands, mobile: false, platform: 'Windows' })
    };
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      get: () => uaData, configurable: true
    });
  } catch (e) {}

  // 3) window.chrome — objeto que el Chrome real expone y Electron no.
  try {
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) window.chrome.runtime = {};
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: () => null,
        getIsInstalled: () => false
      };
    }
    if (!window.chrome.csi) window.chrome.csi = () => ({});
    if (!window.chrome.loadTimes) window.chrome.loadTimes = () => ({});
  } catch (e) {}
})();
