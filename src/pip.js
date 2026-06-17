(function () {
  function init() {
    if (window.__ravePIP) return;
    window.__ravePIP = true;

    const ST = document.createElement('style');
    ST.textContent =
      '.__rpip{position:fixed;z-index:2147483647;padding:7px 16px;border:none;' +
      'border-radius:20px;background:rgba(0,0,0,0.75);backdrop-filter:blur(8px);' +
      '-webkit-backdrop-filter:blur(8px);color:#fff;font-size:13px;font-weight:500;' +
      'font-family:system-ui,sans-serif;cursor:pointer;display:flex;align-items:center;' +
      'gap:7px;opacity:0;pointer-events:none;transition:opacity 180ms ease;' +
      'white-space:nowrap;box-shadow:0 2px 12px rgba(0,0,0,0.4);}' +
      '.__rpip.show{opacity:1;pointer-events:auto;}' +
      '.__rpip svg{width:16px;height:16px;fill:#fff;flex-shrink:0;}' +
      '.__rpip:hover{background:rgba(0,0,0,0.92);}';
    (document.head || document.documentElement).appendChild(ST);

    const ICON =
      '<svg viewBox="0 0 24 24"><path d="M19 7H9a2 2 0 0 0-2 2v6H5V9a4 4 0 0' +
      ' 1 4-4h10v2zm2 4h-8a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-5a1' +
      ' 1 0 0 0-1-1z"/></svg>';

    let btn = null, hideTimer = null, activeVideo = null;

    function ensureBtn() {
      if (btn && btn.isConnected) return btn;
      btn = document.createElement('button');
      btn.className = '__rpip';
      btn.innerHTML = ICON + '<span>Picture in Picture</span>';
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        if (activeVideo) activeVideo.requestPictureInPicture().catch(function () {});
      });
      btn.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
      btn.addEventListener('mouseleave', scheduleHide);
      (document.body || document.documentElement).appendChild(btn);
      return btn;
    }

    function showOn(video) {
      var r = video.getBoundingClientRect();
      if (r.width < 160 || r.height < 90) return;
      activeVideo = video;
      var b = ensureBtn();
      b.style.left = Math.round(r.left + r.width / 2) + 'px';
      b.style.top = Math.round(r.top + 14) + 'px';
      b.style.transform = 'translateX(-50%)';
      clearTimeout(hideTimer);
      b.classList.add('show');
    }

    function scheduleHide() {
      hideTimer = setTimeout(function () {
        if (btn) btn.classList.remove('show');
      }, 500);
    }

    function findVideoAt(x, y) {
      // elementsFromPoint devuelve todos los elementos bajo el cursor en orden z
      var els = document.elementsFromPoint(x, y);
      for (var i = 0; i < els.length; i++) {
        if (els[i].tagName === 'VIDEO') return els[i];
      }
      // Fallback: buscar video cuyo rect contenga el punto
      var videos = document.querySelectorAll('video');
      for (var j = 0; j < videos.length; j++) {
        var r = videos[j].getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return videos[j];
        }
      }
      return null;
    }

    document.addEventListener('mousemove', function (e) {
      var v = findVideoAt(e.clientX, e.clientY);
      if (v && !v.disablePictureInPicture) {
        showOn(v);
      } else if (!btn || !btn.matches(':hover')) {
        scheduleHide();
      }
    }, { passive: true, capture: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
