package com.rave.browser.browser

import java.net.URLEncoder

const val NEWTAB = "file:///android_asset/newtab.html"

fun isInternal(url: String) = url.startsWith(NEWTAB)

val SEARCH_ENGINES = mapOf(
    "ddg" to "https://duckduckgo.com/?q=",
    "google" to "https://www.google.com/search?q=",
    "bing" to "https://www.bing.com/search?q=",
    "brave" to "https://search.brave.com/search?q=",
    "ecosia" to "https://www.ecosia.org/search?q="
)

fun newTabUrl(settings: AppSettings, topSites: List<String> = emptyList()): String {
    val theme = settings.theme
    val sites = topSites.take(8).joinToString(",") { URLEncoder.encode(it, "UTF-8") }
    return "$NEWTAB?theme=$theme&engine=${settings.engine}&sites=$sites"
}

fun homeUrl(settings: AppSettings, topSites: List<String> = emptyList()): String {
    val hp = settings.homepage.trim()
    return if (hp.isNotEmpty()) hp else newTabUrl(settings, topSites)
}

fun toUrl(input: String, settings: AppSettings): String {
    val t = input.trim()
    if (t.isEmpty()) return homeUrl(settings)
    if (t.matches(Regex("(?i)^[a-z]+://.*"))) return t
    if (t.contains('.') && !t.contains(' ')) return "https://$t"
    val prefix = SEARCH_ENGINES[settings.engine] ?: SEARCH_ENGINES["ddg"]!!
    return prefix + URLEncoder.encode(t, "UTF-8")
}

fun upgradeHttps(url: String): String {
    if (!url.startsWith("http://")) return url
    val host = try {
        java.net.URL(url).host?.lowercase() ?: return url
    } catch (_: Exception) {
        return url
    }
    if (host == "localhost" || host == "127.0.0.1" || host.endsWith(".local")) return url
    return "https://" + url.removePrefix("http://")
}
