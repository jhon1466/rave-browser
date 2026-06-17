package com.rave.browser.browser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class Entry(val title: String, val url: String)

data class PasswordEntry(val domain: String, val username: String, val password: String, val ts: Long = System.currentTimeMillis())

data class SessionSnapshot(val name: String, val urls: List<String>, val ts: Long = System.currentTimeMillis())

data class DownloadEntry(val name: String, val url: String, val path: String, val ts: Long, val state: String)

data class TabSnapshot(val url: String, val incognito: Boolean, val pinned: Boolean = false)

/** Persistencia en SharedPreferences (JSON). */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("rave", Context.MODE_PRIVATE)

    private fun read(key: String): MutableList<Entry> {
        val out = mutableListOf<Entry>()
        try {
            val arr = JSONArray(sp.getString(key, "[]"))
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                out.add(Entry(o.optString("title"), o.optString("url")))
            }
        } catch (_: Exception) {}
        return out
    }

    private fun write(key: String, list: List<Entry>) {
        val arr = JSONArray()
        list.forEach { arr.put(JSONObject().put("title", it.title).put("url", it.url)) }
        sp.edit().putString(key, arr.toString()).apply()
    }

    // Marcadores
    fun bookmarks() = read("bookmarks")
    fun isBookmarked(url: String) = bookmarks().any { it.url == url }
    fun toggleBookmark(e: Entry) {
        val list = bookmarks()
        val i = list.indexOfFirst { it.url == e.url }
        if (i >= 0) list.removeAt(i) else list.add(0, e)
        write("bookmarks", list)
    }
    fun removeBookmark(url: String) = write("bookmarks", bookmarks().filter { it.url != url })
    fun setBookmarks(list: List<Entry>) = write("bookmarks", list)

    // Historial
    fun history() = read("history")
    fun addHistory(e: Entry) {
        if (e.url.isBlank()) return
        val list = history()
        if (list.firstOrNull()?.url == e.url) return
        list.add(0, e)
        while (list.size > 2000) list.removeAt(list.size - 1)
        write("history", list)
    }
    fun removeHistory(url: String) = write("history", history().filter { it.url != url })
    fun clearHistory() = write("history", emptyList())
    fun setHistory(list: List<Entry>) = write("history", list)

    // Notas
    fun notes(): String = sp.getString("notes", "") ?: ""
    fun setNotes(v: String) = sp.edit().putString("notes", v).apply()

    // Sesiones guardadas
    fun sessions(): List<SessionSnapshot> {
        val out = mutableListOf<SessionSnapshot>()
        try {
            val arr = JSONArray(sp.getString("sessions", "[]"))
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                val urls = mutableListOf<String>()
                val u = o.optJSONArray("urls") ?: JSONArray()
                for (j in 0 until u.length()) urls.add(u.getString(j))
                out.add(SessionSnapshot(o.optString("name"), urls, o.optLong("ts", 0)))
            }
        } catch (_: Exception) {}
        return out
    }

    fun addSession(s: SessionSnapshot) {
        val list = sessions().toMutableList()
        list.add(0, s)
        val arr = JSONArray()
        list.forEach { snap ->
            val u = JSONArray()
            snap.urls.forEach { u.put(it) }
            arr.put(JSONObject().put("name", snap.name).put("urls", u).put("ts", snap.ts))
        }
        sp.edit().putString("sessions", arr.toString()).apply()
    }

    fun removeSession(name: String) {
        val arr = JSONArray()
        sessions().filter { it.name != name }.forEach { snap ->
            val u = JSONArray()
            snap.urls.forEach { u.put(it) }
            arr.put(JSONObject().put("name", snap.name).put("urls", u).put("ts", snap.ts))
        }
        sp.edit().putString("sessions", arr.toString()).apply()
    }

    // Descargas (metadatos)
    fun downloads(): List<DownloadEntry> {
        val out = mutableListOf<DownloadEntry>()
        try {
            val arr = JSONArray(sp.getString("downloads", "[]"))
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                out.add(DownloadEntry(
                    o.optString("name"), o.optString("url"), o.optString("path"),
                    o.optLong("ts"), o.optString("state", "completed")
                ))
            }
        } catch (_: Exception) {}
        return out
    }

    fun addDownload(d: DownloadEntry) {
        val list = downloads().toMutableList()
        list.add(0, d)
        while (list.size > 200) list.removeAt(list.size - 1)
        val arr = JSONArray()
        list.forEach { e ->
            arr.put(JSONObject()
                .put("name", e.name).put("url", e.url).put("path", e.path)
                .put("ts", e.ts).put("state", e.state))
        }
        sp.edit().putString("downloads", arr.toString()).apply()
    }

    fun clearDownloads() = sp.edit().putString("downloads", "[]").apply()

    // Pestañas abiertas (restauración de sesión)
    fun tabSession(): List<TabSnapshot> {
        val out = mutableListOf<TabSnapshot>()
        try {
            val arr = JSONArray(sp.getString("tabs", "[]"))
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                out.add(TabSnapshot(o.optString("url"), o.optBoolean("incognito"), o.optBoolean("pinned")))
            }
        } catch (_: Exception) {}
        return out
    }

    fun saveTabSession(tabs: List<TabSnapshot>, activeIndex: Int) {
        val arr = JSONArray()
        tabs.forEach { t ->
            arr.put(JSONObject().put("url", t.url).put("incognito", t.incognito).put("pinned", t.pinned))
        }
        sp.edit().putString("tabs", arr.toString()).putInt("activeTab", activeIndex).apply()
    }

    fun activeTabIndex() = sp.getInt("activeTab", 0)

    fun topSites(limit: Int = 8): List<String> {
        val seen = LinkedHashSet<String>()
        for (e in history()) {
            if (isInternal(e.url)) continue
            try {
                val host = java.net.URL(e.url).host ?: continue
                if (seen.add(host)) seen.add("https://$host")
            } catch (_: Exception) {}
            if (seen.size >= limit) break
        }
        return seen.toList()
    }
}
