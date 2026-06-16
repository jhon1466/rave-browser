package com.rave.browser.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Paleta monocromática de Rave (blanco / negro / gris).
private val Ink = Color(0xFF0A0A0A)
private val InkSoft = Color(0xFF6B6B70)
private val Bg = Color(0xFFFFFFFF)
private val Surface = Color(0xFFF4F4F5)
private val Border = Color(0xFFD8D8DC)

private val InkD = Color(0xFFF5F5F5)
private val InkSoftD = Color(0xFF9A9AA0)
private val BgD = Color(0xFF0D0D0F)
private val SurfaceD = Color(0xFF161618)
private val BorderD = Color(0xFF2E2E33)

private val LightColors = lightColorScheme(
    primary = Ink, onPrimary = Bg,
    background = Bg, onBackground = Ink,
    surface = Surface, onSurface = Ink,
    surfaceVariant = Border, onSurfaceVariant = InkSoft,
    outline = Border
)

private val DarkColors = darkColorScheme(
    primary = InkD, onPrimary = BgD,
    background = BgD, onBackground = InkD,
    surface = SurfaceD, onSurface = InkD,
    surfaceVariant = BorderD, onSurfaceVariant = InkSoftD,
    outline = BorderD
)

@Composable
fun RaveTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        content = content
    )
}
