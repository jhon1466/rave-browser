package com.rave.browser.browser

import android.content.Context
import org.json.JSONObject

data class AppSettings(
    val engine: String = "ddg",
    val homepage: String = "",
    val theme: String = "system",
    val savePasswords: Boolean = true,
    val showBookmarksBar: Boolean = true,
    val animations: Boolean = true,
    val trackingLevel: String = "standard",
    val dnt: Boolean = false,
    val httpsOnly: Boolean = false,
    val clearOnExit: Boolean = false,
    val desktopMode: Boolean = false,
    val adBlock: Boolean = true
) {
    fun wantDnt() = dnt || trackingLevel == "strict"
    fun wantGpc() = trackingLevel == "strict"
}

object SettingsStore {
    private const val KEY = "settings"
    private const val WELCOME_KEY = "welcome_seen"

    fun hasSeenWelcome(ctx: Context): Boolean =
        ctx.getSharedPreferences("rave", Context.MODE_PRIVATE).getBoolean(WELCOME_KEY, false)

    fun setWelcomeSeen(ctx: Context) {
        ctx.getSharedPreferences("rave", Context.MODE_PRIVATE).edit().putBoolean(WELCOME_KEY, true).apply()
    }

    fun load(ctx: Context): AppSettings {
        val raw = ctx.getSharedPreferences("rave", Context.MODE_PRIVATE).getString(KEY, null) ?: return AppSettings()
        return try {
            val o = JSONObject(raw)
            AppSettings(
                engine = o.optString("engine", "ddg"),
                homepage = o.optString("homepage", ""),
                theme = o.optString("theme", "system"),
                savePasswords = o.optBoolean("savePasswords", true),
                showBookmarksBar = o.optBoolean("showBookmarksBar", true),
                animations = o.optBoolean("animations", true),
                trackingLevel = o.optString("trackingLevel", "standard"),
                dnt = o.optBoolean("dnt", false),
                httpsOnly = o.optBoolean("httpsOnly", false),
                clearOnExit = o.optBoolean("clearOnExit", false),
                desktopMode = o.optBoolean("desktopMode", false),
                adBlock = o.optBoolean("adBlock", true)
            )
        } catch (_: Exception) {
            AppSettings()
        }
    }

    fun save(ctx: Context, s: AppSettings) {
        val o = JSONObject()
            .put("engine", s.engine)
            .put("homepage", s.homepage)
            .put("theme", s.theme)
            .put("savePasswords", s.savePasswords)
            .put("showBookmarksBar", s.showBookmarksBar)
            .put("animations", s.animations)
            .put("trackingLevel", s.trackingLevel)
            .put("dnt", s.dnt)
            .put("httpsOnly", s.httpsOnly)
            .put("clearOnExit", s.clearOnExit)
            .put("desktopMode", s.desktopMode)
            .put("adBlock", s.adBlock)
        ctx.getSharedPreferences("rave", Context.MODE_PRIVATE).edit().putString(KEY, o.toString()).apply()
    }
}
