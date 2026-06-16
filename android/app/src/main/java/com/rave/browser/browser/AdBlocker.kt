package com.rave.browser.browser

import android.content.Context
import android.webkit.WebResourceResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.ByteArrayInputStream
import java.net.URL

/**
 * Bloqueador de anuncios/rastreo para Rave (Android).
 *
 * Estrategia equivalente a la del escritorio: una lista de dominios. Al
 * interceptar cada petición de red del WebView, si el host coincide se
 * devuelve una respuesta vacía (la petición no se realiza).
 *
 * Parte de una lista base en assets y, al arrancar, la amplía descargando
 * EasyList/EasyPrivacy y extrayendo sus reglas de dominio (||dominio^).
 */
object AdBlocker {

    private val blocked = HashSet<String>()
    @Volatile var enabled = true
    @Volatile var blockedCount = 0
        private set

    private val EMPTY = WebResourceResponse(
        "text/plain", "utf-8", ByteArrayInputStream(ByteArray(0))
    )

    private val FILTER_LISTS = listOf(
        "https://easylist.to/easylist/easylist.txt",
        "https://easylist.to/easylist/easyprivacy.txt"
    )

    /** Carga la lista base de assets y lanza la actualización remota. */
    fun init(context: Context, scope: CoroutineScope) {
        scope.launch(Dispatchers.IO) {
            try {
                context.assets.open("adblock_hosts.txt").bufferedReader().useLines { lines ->
                    lines.forEach { raw ->
                        val l = raw.trim()
                        if (l.isNotEmpty() && !l.startsWith("#")) synchronized(blocked) { blocked.add(l) }
                    }
                }
            } catch (_: Exception) {}
            fetchRemoteLists()
        }
    }

    private fun fetchRemoteLists() {
        for (url in FILTER_LISTS) {
            try {
                URL(url).openStream().bufferedReader().useLines { lines ->
                    lines.forEach { line ->
                        // Reglas simples del tipo: ||dominio.com^
                        if (line.startsWith("||")) {
                            val end = line.indexOf('^')
                            if (end > 2) {
                                val host = line.substring(2, end)
                                if (host.isNotEmpty() && '/' !in host && '*' !in host) {
                                    synchronized(blocked) { blocked.add(host) }
                                }
                            }
                        }
                    }
                }
            } catch (_: Exception) { /* sin red: nos quedamos con la lista base */ }
        }
    }

    private fun hostBlocked(host: String): Boolean {
        synchronized(blocked) {
            if (blocked.contains(host)) return true
            // Coincidencia por subdominio: a.b.ads.com -> prueba ads.com, b.ads.com...
            var i = host.indexOf('.')
            while (i >= 0) {
                if (blocked.contains(host.substring(i + 1))) return true
                i = host.indexOf('.', i + 1)
            }
        }
        return false
    }

    /** Devuelve EMPTY si la URL debe bloquearse, o null para dejarla pasar. */
    fun intercept(url: String?): WebResourceResponse? {
        if (!enabled || url == null) return null
        return try {
            val host = URL(url).host ?: return null
            if (hostBlocked(host)) { blockedCount++; EMPTY } else null
        } catch (_: Exception) { null }
    }
}
