# Rave para Android

Navegador Rave en **Kotlin + Jetpack Compose**, usando el **WebView** del sistema
(motor Chromium de Android). Mantiene la estética monocromática blanco/negro/gris.

## Requisitos
- **Android Studio** (Ladybug o superior).
- JDK 17 (lo trae Android Studio).
- Un dispositivo o emulador con Android 7.0 (API 24) o superior.

## Cómo abrirlo y ejecutarlo
1. Abre **Android Studio** → *Open* → selecciona la carpeta `android/`.
2. Android Studio descargará Gradle 8.9 y las dependencias, y generará el
   `gradle wrapper` automáticamente (la primera vez tarda unos minutos).
3. Pulsa **Run ▶** con un emulador o teléfono conectado.

> Desde terminal (si tienes el SDK configurado y el wrapper generado):
> `./gradlew :app:installDebug`

## Funciones de esta v1
- Pestañas múltiples (con barra de pestañas y botón +).
- Barra de direcciones con búsqueda (DuckDuckGo) o navegación directa.
- Atrás / recargar / parar, barra de progreso, botón de inicio.
- Página de inicio propia (`assets/newtab.html`) con la marca Rave.
- **Bloqueo de anuncios** por lista de dominios (`assets/adblock_hosts.txt`),
  ampliada al arrancar descargando EasyList/EasyPrivacy. Activable/desactivable.
- Marcadores e historial (persistidos en `SharedPreferences`).
- Pestañas de **incógnito** (no guardan historial).
- Tema claro/oscuro automático según el sistema.
- **Actualizaciones OTA**: comprueba al arrancar (y desde el menú) un manifiesto
  JSON en tu servidor; si hay versión nueva, descarga el APK y lanza el instalador.

## Configurar actualizaciones OTA
1. Edita `MANIFEST_URL` en `browser/Updater.kt` con la URL de tu manifiesto.
2. Sube a tu servidor un `latest.json`:
   ```json
   {
     "versionCode": 2,
     "versionName": "0.2.0",
     "apkUrl": "https://TU-SERVIDOR.com/rave/android/rave-0.2.0.apk",
     "notes": "Novedades de esta versión"
   }
   ```
3. Sube también el APK firmado a esa `apkUrl`. Cuando subas `versionCode` mayor
   que el instalado, los usuarios recibirán el aviso de actualización.

## Limitaciones (propias de Android WebView)
- **Sin extensiones de Chrome**: el WebView de Android no las soporta. Eso solo
  es posible con un fork completo de Chromium (Kiwi/Brave) o con GeckoView.
- El bloqueo de anuncios en YouTube es limitado (no hay inyección de scriptlets
  como en escritorio). El bloqueo por red sí funciona.
- Incógnito comparte el almacén de cookies global del WebView (aproximación).

## Estructura
```
android/
├─ app/
│  ├─ src/main/
│  │  ├─ AndroidManifest.xml
│  │  ├─ assets/            newtab.html, adblock_hosts.txt
│  │  ├─ res/               temas, icono
│  │  └─ java/com/rave/browser/
│  │     ├─ MainActivity.kt        UI completa (Compose) + gestión de pestañas
│  │     ├─ browser/AdBlocker.kt   intercepción de peticiones + listas
│  │     ├─ browser/Prefs.kt       marcadores e historial
│  │     └─ ui/theme/Theme.kt      paleta monocromática
│  └─ build.gradle.kts
├─ build.gradle.kts
└─ settings.gradle.kts
```
