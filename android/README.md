# Rave para Android

Navegador Rave en **Kotlin + Jetpack Compose**, usando el **WebView** del sistema
(motor Chromium de Android). Mantiene la estética monocromática blanco/negro/gris.

## Requisitos
- **Android Studio** (Ladybug o superior).
- JDK 17 (lo trae Android Studio).
- Un dispositivo o emulador con Android 7.0 (API 24) o superior.

## Cómo abrirlo y ejecutarlo
1. Abre **Android Studio** → *Open* → selecciona la carpeta `android/`.
2. Android Studio descargará Gradle y las dependencias (la primera vez tarda unos minutos).
3. Pulsa **Run ▶** con un emulador o teléfono conectado.

## Funciones (paridad con escritorio)

### Pestañas y navegación
- Pestañas múltiples con fijar, duplicar, reabrir cerrada y cerrar otras
- Incógnito (sin historial; cookies de sesión se limpian al cerrar)
- Atrás / adelante / recargar / parar, barra de progreso
- Restauración de sesión al reiniciar la app
- Enlaces externos (`http`/`https`) abren en Rave
- Pop-ups (`target="_blank"`) abren en nueva pestaña
- Subida de archivos (`<input type="file">`)

### Barra de direcciones
- Omnibox con sugerencias (marcadores + historial)
- 5 motores de búsqueda (DuckDuckGo, Google, Bing, Brave, Ecosia)
- Indicador HTTPS, botón de marcador

### Página de inicio
- Reloj, fecha, accesos rápidos desde historial
- Tema sincronizado con ajustes

### Marcadores e historial
- Añadir/quitar, panel con eliminar individual
- Historial (2000 entradas), borrar todo o por item
- Barra de marcadores opcional
- Exportar/importar JSON

### Privacidad y bloqueo
- Bloqueo de anuncios por dominios (EasyList + EasyPrivacy)
- Contador en escudo de la barra
- Protección de rastreo: desactivada / estándar / estricta (DNT + Sec-GPC)
- Modo solo HTTPS
- Borrar datos al salir
- Panel de cookies por sitio

### Herramientas de página
- Buscar en la página
- Modo lectura
- Captura de pantalla
- Imprimir
- Zoom +/−/100%
- Compartir enlace
- Sitio de escritorio (User-Agent)

### Datos personales
- Gestor de contraseñas cifrado (AES-GCM)
- Notas rápidas
- Sesiones guardadas (snapshots de pestañas)

### Descargas
- Gestor de descargas web (DownloadManager del sistema)
- Panel con historial de descargas

### Ajustes
- Motor de búsqueda, homepage, tema (sistema/claro/oscuro/Orange Eclipse)
- **Navegador predeterminado** — botón en ajustes para abrir el selector del sistema
- Barra de marcadores, animaciones, contraseñas, HTTPS-only, adblock
- Exportar / importar / borrar todos los datos

### Primera ejecución
- Diálogo de bienvenida con opción de establecer Rave como navegador predeterminado

### Actualizaciones OTA
- Comprueba al arrancar y desde el menú un manifiesto JSON en tu servidor

## Configurar actualizaciones OTA
1. Edita `MANIFEST_URL` en `browser/Updater.kt`.
2. Sube un `latest.json` con `versionCode`, `versionName`, `apkUrl` y `notes`.
3. Sube el APK firmado a `apkUrl`.

## Limitaciones (propias de WebView)
- **Sin extensiones de Chrome** — requiere un fork de Chromium (Kiwi/Brave) o GeckoView
- **Sin pantalla dividida** — feature exclusiva del escritorio (Electron)
- **Sin suspensión de pestañas** — no aplica igual en móvil
- Bloqueo de anuncios en YouTube es limitado (sin scriptlets como en escritorio)
- Incógnito no aísla cookies al 100% entre pestañas normales e incógnito

## Estructura
```
android/app/src/main/java/com/rave/browser/
├── MainActivity.kt           UI principal + menú completo
├── browser/
│   ├── AdBlocker.kt          bloqueo por dominios
│   ├── DownloadHelper.kt     descargas web
│   ├── Prefs.kt              marcadores, historial, sesiones, etc.
│   ├── ReaderMode.kt         inyección CSS lectura
│   ├── SearchUtils.kt        URL, motores, HTTPS
│   ├── SecureStore.kt        contraseñas cifradas
│   ├── Settings.kt           ajustes persistentes
│   ├── TabModel.kt           estado de pestaña
│   ├── Updater.kt            OTA APK
│   └── WebViewFactory.kt     creación WebView + handlers
└── ui/
    ├── BrowserPanels.kt      diálogos y paneles
    └── theme/Theme.kt        paleta monocromática + eclipse
```
