package com.rave.browser.browser

import android.content.Context

/**
 * Decisiones de permisos recordadas por sitio (origen + tipo de permiso).
 * Equivalente al `permDecisions` del escritorio: si el usuario marca "recordar",
 * no se vuelve a preguntar para ese origen y permiso.
 */
class SitePermissions(context: Context) {
    private val sp = context.getSharedPreferences("rave_perms", Context.MODE_PRIVATE)

    private fun key(origin: String, perms: List<String>) =
        origin + "|" + perms.sorted().joinToString(",")

    /** true = permitido, false = bloqueado, null = sin decisión (preguntar). */
    fun decision(origin: String, perms: List<String>): Boolean? {
        val k = key(origin, perms)
        return if (sp.contains(k)) sp.getBoolean(k, false) else null
    }

    fun remember(origin: String, perms: List<String>, allow: Boolean) {
        sp.edit().putBoolean(key(origin, perms), allow).apply()
    }
}
