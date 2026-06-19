package com.rave.browser.browser

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Almacén cifrado de contraseñas (AES-GCM 256).
 *
 * La clave se genera y custodia en el **Android Keystore** (respaldada por
 * hardware cuando el dispositivo lo permite): no es exportable ni queda en
 * disco en claro. Esto sustituye al esquema anterior, que guardaba la clave en
 * texto plano en SharedPreferences (y por tanto no protegía frente a un backup
 * o acceso al almacenamiento de la app).
 *
 * Compatibilidad: los blobs antiguos no llevan prefijo; los nuevos llevan
 * "v2:". Al construirse, [migrateLegacy] re-cifra los datos antiguos con la
 * clave del Keystore y borra la clave en claro.
 */
class SecureStore(context: Context) {
    private val sp = context.getSharedPreferences("rave_secure", Context.MODE_PRIVATE)

    private val secretKey: SecretKey by lazy { getOrCreateKeystoreKey() }

    init { migrateLegacy() }

    // --- Clave del Keystore -------------------------------------------------
    private fun getOrCreateKeystoreKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    // --- Cifrado ------------------------------------------------------------
    private fun encrypt(plain: String): String {
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.ENCRYPT_MODE, secretKey)   // el Keystore genera un IV aleatorio
        val iv = c.iv
        val enc = c.doFinal(plain.toByteArray(Charsets.UTF_8))
        return PREFIX_V2 + Base64.encodeToString(iv + enc, Base64.NO_WRAP)
    }

    private fun decrypt(blob: String): String {
        return if (blob.startsWith(PREFIX_V2)) {
            decryptWith(secretKey, blob.substring(PREFIX_V2.length))
        } else {
            // Formato antiguo: clave en texto plano dentro de SharedPreferences.
            val legacy = legacyKey() ?: return ""
            decryptWith(legacy, blob)
        }
    }

    private fun decryptWith(key: SecretKey, b64: String): String {
        val raw = Base64.decode(b64, Base64.DEFAULT)
        val iv = raw.copyOfRange(0, 12)
        val data = raw.copyOfRange(12, raw.size)
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
        return String(c.doFinal(data), Charsets.UTF_8)
    }

    // --- Migración del esquema antiguo --------------------------------------
    private fun legacyKey(): SecretKey? {
        val existing = sp.getString(LEGACY_KEY, null) ?: return null
        return SecretKeySpec(Base64.decode(existing, Base64.DEFAULT), "AES")
    }

    private fun migrateLegacy() {
        if (sp.getString(LEGACY_KEY, null) == null) return
        try {
            val list = passwords()   // descifra con la clave antigua
            save(list)               // re-cifra con la clave del Keystore (v2)
        } catch (_: Exception) {
            // Si algo falla, no borramos la clave antigua para no perder datos.
            return
        }
        sp.edit().remove(LEGACY_KEY).apply()   // elimina la clave en claro
    }

    // --- API pública --------------------------------------------------------
    fun passwords(): List<PasswordEntry> {
        val out = mutableListOf<PasswordEntry>()
        try {
            val arr = JSONArray(sp.getString("passwords", "[]"))
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                out.add(PasswordEntry(
                    o.getString("domain"),
                    o.getString("username"),
                    decrypt(o.getString("password")),
                    o.optLong("ts", 0)
                ))
            }
        } catch (_: Exception) {}
        return out
    }

    fun addPassword(e: PasswordEntry) {
        val list = passwords().filter { !(it.domain == e.domain && it.username == e.username) }.toMutableList()
        list.add(0, e)
        save(list)
    }

    fun removePassword(domain: String, username: String) {
        save(passwords().filter { !(it.domain == domain && it.username == username) })
    }

    private fun save(list: List<PasswordEntry>) {
        val arr = JSONArray()
        list.forEach { e ->
            arr.put(JSONObject()
                .put("domain", e.domain)
                .put("username", e.username)
                .put("password", encrypt(e.password))
                .put("ts", e.ts))
        }
        sp.edit().putString("passwords", arr.toString()).apply()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "rave_pw_key"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val PREFIX_V2 = "v2:"
        const val LEGACY_KEY = "key"   // clave antigua (texto plano) en SharedPreferences
    }
}
