# Rave

Un navegador minimalista en **blanco, negro y gris**, basado en Chromium, con
foco en el diseño. Inspirado en Brave pero con identidad propia.

Dos plataformas en este repositorio:

| Plataforma | Tecnología | Carpeta |
|---|---|---|
| **Escritorio** (Windows/Mac/Linux) | Electron + WebContentsView | raíz / `src/` |
| **Android** | Kotlin + Jetpack Compose + WebView | `android/` |

La versión Android incluye la mayoría de funciones del escritorio (pestañas, incógnito, marcadores, historial, ajustes, descargas, adblock, contraseñas, etc.). Ver [android/README.md](android/README.md).

## Funciones
- 🎨 Estética monocromática (modo claro/oscuro automático)
- 📑 Pestañas (reordenables en escritorio), incógnito
- 🔎 Barra de direcciones con búsqueda y sugerencias
- ⭐ Marcadores, 🕐 historial, ⚙️ ajustes, ⬇️ descargas
- 🛡️ Bloqueo de anuncios nivel uBlock Origin (escritorio) / por listas (Android)
- 🧩 Extensiones de Chrome + Chrome Web Store (solo escritorio)
- 🔄 Actualizaciones OTA en ambas plataformas

## Escritorio

```bash
npm install
npm start          # ejecutar en desarrollo
npm run dist       # generar instalador (electron-builder)
```
## Licencia
GPL-3.0
