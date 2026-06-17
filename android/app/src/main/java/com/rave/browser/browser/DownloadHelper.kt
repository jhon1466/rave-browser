package com.rave.browser.browser

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.webkit.CookieManager
import android.webkit.URLUtil

object DownloadHelper {

    fun enqueue(
        context: Context,
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?,
        onAdded: (DownloadEntry) -> Unit
    ) {
        val filename = URLUtil.guessFileName(url, contentDisposition, mimeType)
        val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val req = DownloadManager.Request(Uri.parse(url)).apply {
            setTitle(filename)
            setDescription("Descargando con Rave")
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
            userAgent?.let { addRequestHeader("User-Agent", it) }
            val cookies = CookieManager.getInstance().getCookie(url)
            if (!cookies.isNullOrBlank()) addRequestHeader("Cookie", cookies)
        }
        dm.enqueue(req)
        onAdded(DownloadEntry(filename, url, filename, System.currentTimeMillis(), "completed"))
    }
}
