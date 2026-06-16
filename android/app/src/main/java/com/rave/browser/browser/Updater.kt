package com.rave.browser.browser

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.URL

/**
 * Actualizaciones OTA de Rave (Android) para APK distribuido fuera de Play Store.
 *
 * Aloja en tu servidor un JSON como:
 * {
 *   "versionCode": 2,
 *   "versionName": "0.2.0",
 *   "apkUrl": "https://TU-SERVIDOR.com/rave/android/rave-0.2.0.apk",
 *   "notes": "Novedades de esta versión"
 * }
 * y apunta MANIFEST_URL a ese archivo.
 */
object Updater {

    const val MANIFEST_URL = "https://TU-SERVIDOR.com/rave/android/latest.json"

    data class Info(val versionCode: Int, val versionName: String, val apkUrl: String, val notes: String)

    /** Devuelve Info si hay una versión más nueva que la instalada, o null. */
    suspend fun check(currentCode: Int): Info? = withContext(Dispatchers.IO) {
        try {
            val o = JSONObject(URL(MANIFEST_URL).readText())
            val info = Info(
                o.getInt("versionCode"),
                o.optString("versionName"),
                o.getString("apkUrl"),
                o.optString("notes")
            )
            if (info.versionCode > currentCode) info else null
        } catch (_: Exception) { null }
    }

    /** Descarga el APK a la caché externa. Devuelve el archivo o null. */
    suspend fun download(context: Context, url: String): File? = withContext(Dispatchers.IO) {
        try {
            val file = File(context.externalCacheDir, "rave-update.apk")
            URL(url).openStream().use { input -> file.outputStream().use { input.copyTo(it) } }
            file
        } catch (_: Exception) { null }
    }

    /** Lanza el instalador del sistema para el APK descargado. */
    fun install(context: Context, file: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION
        }
        context.startActivity(intent)
    }
}
