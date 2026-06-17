package com.rave.browser.browser

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Almacén cifrado simple para contraseñas (AES-GCM con clave en prefs). */
class SecureStore(context: Context) {
    private val sp = context.getSharedPreferences("rave_secure", Context.MODE_PRIVATE)
    private val key: ByteArray by lazy {
        val existing = sp.getString("key", null)
        if (existing != null) return@lazy Base64.decode(existing, Base64.DEFAULT)
        val k = ByteArray(32).also { SecureRandom().nextBytes(it) }
        sp.edit().putString("key", Base64.encodeToString(k, Base64.DEFAULT)).apply()
        k
    }

    private fun encrypt(plain: String): String {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        val enc = c.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(iv + enc, Base64.NO_WRAP)
    }

    private fun decrypt(blob: String): String {
        val raw = Base64.decode(blob, Base64.DEFAULT)
        val iv = raw.copyOfRange(0, 12)
        val data = raw.copyOfRange(12, raw.size)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        return String(c.doFinal(data), Charsets.UTF_8)
    }

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
}
