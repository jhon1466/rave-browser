package com.rave.browser.browser

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.net.Uri
import android.os.Message
import android.view.ViewGroup
import android.webkit.*
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import java.net.URL

data class WebViewCallbacks(
    val onPopup: (String) -> Unit,
    val onDownload: (String, String?, String?, String?) -> Unit,
    val onPasswordForm: (String) -> Unit = {},
    val onFileChooser: ((ValueCallback<Array<Uri>>, WebChromeClient.FileChooserParams) -> Boolean)? = null
)

@SuppressLint("SetJavaScriptEnabled")
fun createTab(
    activity: ComponentActivity,
    prefs: Prefs,
    settings: AppSettings,
    incognito: Boolean,
    startUrl: String,
    callbacks: WebViewCallbacks,
    desktopUa: String? = null
): TabModel {
    val wv = WebView(activity)
    wv.layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
    )
    wv.settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        loadWithOverviewMode = true
        useWideViewPort = true
        builtInZoomControls = true
        displayZoomControls = false
        mediaPlaybackRequiresUserGesture = false
        setSupportMultipleWindows(true)
        javaScriptCanOpenWindowsAutomatically = true
        userAgentString = (desktopUa ?: userAgentString).replace("; wv", "")
    }
    val tab = TabModel(wv, incognito)

    wv.webViewClient = object : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (AdBlocker.enabled && settings.adBlock) {
                AdBlocker.intercept(request.url?.toString())?.let { return it }
            }
            return null
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url?.toString() ?: return false
            if (settings.httpsOnly && url.startsWith("http://")) {
                view.loadUrl(upgradeHttps(url), extraHeaders(settings))
                return true
            }
            return false
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            tab.url = url
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            tab.url = url
            tab.canBack = view.canGoBack()
            tab.canForward = view.canGoForward()
        }

        override fun onPageFinished(view: WebView, url: String) {
            tab.url = url
            tab.title = view.title ?: url
            tab.canBack = view.canGoBack()
            tab.canForward = view.canGoForward()
            if (!incognito && !isInternal(url)) prefs.addHistory(Entry(tab.title, url))
            if (settings.savePasswords && !incognito) {
                view.evaluateJavascript(
                    "(function(){return !!document.querySelector('input[type=password]');})();"
                ) { r -> if (r == "true") callbacks.onPasswordForm(url) }
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) {
                val html = """
                    <html><body style="font-family:sans-serif;background:#0d0d0f;color:#f5f5f5;display:grid;place-items:center;height:100vh;margin:0">
                    <div style="text-align:center"><h2>Sin conexión</h2><p>No se pudo cargar la página.</p>
                    <button onclick="location.reload()" style="padding:10px 20px;border-radius:8px;border:none;background:#fff;color:#000">Reintentar</button></div></body></html>
                """.trimIndent()
                view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
            }
        }
    }

    wv.webChromeClient = object : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) { tab.progress = newProgress }
        override fun onReceivedTitle(view: WebView, title: String?) { if (title != null) tab.title = title }

        override fun onCreateWindow(
            view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message
        ): Boolean {
            val href = view.hitTestResult.extra
            if (!href.isNullOrBlank()) {
                callbacks.onPopup(href)
                return false
            }
            return false
        }

        override fun onGeolocationPermissionsShowPrompt(
            origin: String, callback: GeolocationPermissions.Callback
        ) {
            callback.invoke(origin, true, false)
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            request.grant(request.resources)
        }

        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams
        ): Boolean {
            return callbacks.onFileChooser?.invoke(filePathCallback, fileChooserParams) ?: false
        }
    }

    wv.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
        callbacks.onDownload(url, userAgent, contentDisposition, mimeType)
    }

    wv.loadUrl(startUrl, extraHeaders(settings))
    return tab
}

fun extraHeaders(settings: AppSettings): Map<String, String> {
    val h = mutableMapOf<String, String>()
    if (settings.wantDnt()) h["DNT"] = "1"
    if (settings.wantGpc()) h["Sec-GPC"] = "1"
    return h
}

fun desktopUserAgent(default: String): String {
    return default
        .replace("; wv", "")
        .replace("Mobile", "Mobile")
        .let { if (it.contains("Mobile")) it.replace("Mobile", "X11") else "$it Mobile" }
}

fun clearBrowserData(activity: Activity) {
    CookieManager.getInstance().removeAllCookies(null)
    CookieManager.getInstance().flush()
    WebStorage.getInstance().deleteAllData()
    activity.cacheDir.deleteRecursively()
    activity.applicationContext.cacheDir.deleteRecursively()
}

fun siteCookies(url: String): List<Pair<String, String>> {
    val cm = android.webkit.CookieManager.getInstance()
    val raw = cm.getCookie(url) ?: return emptyList()
    return raw.split(";").mapNotNull { part ->
        val kv = part.trim().split("=", limit = 2)
        if (kv.size == 2) kv[0] to kv[1] else null
    }
}

fun clearSiteCookies(url: String) {
    try {
        val host = URL(url).host ?: return
        val cm = android.webkit.CookieManager.getInstance()
        val cookies = cm.getCookie(url) ?: return
        cookies.split(";").forEach { part ->
            val name = part.trim().split("=").firstOrNull() ?: return@forEach
            cm.setCookie(url, "$name=; Max-Age=0")
        }
        cm.flush()
    } catch (_: Exception) {}
}
