// Script que Rave inyecta DENTRO de las páginas de YouTube para neutralizar
// los anuncios que el bloqueo por red no puede frenar (se sirven desde el
// mismo dominio que el vídeo). Estrategia: saltar/acelerar anuncios de vídeo,
// cerrar overlays y eliminar banners. Se reinstala solo y persiste en la SPA.
//
// Se exporta como CADENA para inyectarla con webview.executeJavaScript().
window.YT_ADSKIP = `(function () {
  if (window.__raveYT) return;
  window.__raveYT = true;

  function tick() {
    try {
      var video = document.querySelector('video');
      var player = document.querySelector('.html5-video-player');

      // Botón "Saltar anuncio" (varias variantes).
      var skip = document.querySelector(
        '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button'
      );
      if (skip) skip.click();

      // Anuncio de vídeo en curso: lo adelantamos al final y lo silenciamos.
      if (player && player.classList.contains('ad-showing') && video) {
        if (!isNaN(video.duration) && isFinite(video.duration)) {
          video.currentTime = video.duration;
        }
        video.muted = true;
        video.playbackRate = 16;
      }

      // Cerrar overlays.
      var ov = document.querySelector('.ytp-ad-overlay-close-button, .ytp-ad-overlay-close-container');
      if (ov) ov.click();

      // Eliminar banners y huecos de anuncios del feed/lateral.
      var sel = [
        '#player-ads', '.ytp-ad-overlay-slot', '.ytp-ad-module',
        'ytd-display-ad-renderer', 'ytd-promoted-video-renderer',
        'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer',
        'ytd-companion-slot-renderer', '#masthead-ad', 'ytd-banner-promo-renderer'
      ].join(',');
      document.querySelectorAll(sel).forEach(function (e) { e.remove(); });
    } catch (e) {}
  }

  setInterval(tick, 250);
  tick();
})();`;
