package com.rave.browser.browser

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings

object DefaultBrowser {

    fun isDefault(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val rm = context.getSystemService(RoleManager::class.java) ?: return false
            return rm.isRoleAvailable(RoleManager.ROLE_BROWSER) && rm.isRoleHeld(RoleManager.ROLE_BROWSER)
        }
        @Suppress("DEPRECATION")
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("http://www.example.com"))
        val info = context.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)
        return info?.activityInfo?.packageName == context.packageName
    }

    /** Intent del sistema para elegir Rave como navegador predeterminado, o null si ya lo es. */
    fun createRequestIntent(context: Context): Intent? {
        if (isDefault(context)) return null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val rm = context.getSystemService(RoleManager::class.java) ?: return fallbackIntent()
            if (rm.isRoleAvailable(RoleManager.ROLE_BROWSER)) {
                return rm.createRequestRoleIntent(RoleManager.ROLE_BROWSER)
            }
        }
        return fallbackIntent()
    }

    private fun fallbackIntent(): Intent =
        Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)
}
