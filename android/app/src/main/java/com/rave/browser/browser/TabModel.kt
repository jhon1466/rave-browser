package com.rave.browser.browser

import android.webkit.WebView
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** Estado observable de una pestaña. */
class TabModel(
    val webView: WebView,
    val incognito: Boolean,
    pinned: Boolean = false
) {
    var url by mutableStateOf(NEWTAB)
    var title by mutableStateOf("Nueva pestaña")
    var progress by mutableIntStateOf(0)
    var canBack by mutableStateOf(false)
    var canForward by mutableStateOf(false)
    var pinned by mutableStateOf(pinned)
    var zoom by mutableIntStateOf(100)
}
