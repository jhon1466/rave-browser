package com.rave.browser.browser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Entrada simple de marcador / historial. */
data class Entry(val title: String, val url: String)

/** Persistencia ligera en SharedPreferences (JSON). */
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

    // Historial
    fun history() = read("history")
    fun addHistory(e: Entry) {
        if (e.url.isBlank()) return
        val list = history()
        if (list.firstOrNull()?.url == e.url) return
        list.add(0, e)
        while (list.size > 1000) list.removeAt(list.size - 1)
        write("history", list)
    }
    fun clearHistory() = write("history", emptyList())
}
