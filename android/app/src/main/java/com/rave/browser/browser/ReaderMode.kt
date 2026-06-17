package com.rave.browser.browser

object ReaderMode {
    val CSS = """
        (function(){
          if(document.getElementById('rave-reader')) return;
          var s=document.createElement('style');
          s.id='rave-reader';
          s.textContent='body{background:#fafafa!important;color:#111!important;max-width:720px;margin:0 auto!important;padding:24px!important;font-family:Georgia,serif!important;line-height:1.7!important}img,video,iframe{max-width:100%!important;height:auto!important}nav,header,footer,aside,.ad,.ads,[class*="ad-"],[id*="ad-"]{display:none!important}';
          document.head.appendChild(s);
        })();
    """.trimIndent()
}
