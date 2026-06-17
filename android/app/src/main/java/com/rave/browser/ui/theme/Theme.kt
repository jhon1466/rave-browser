package com.rave.browser.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

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

private val EclipseBg = Color(0xFF1A0F08)
private val EclipseSurface = Color(0xFF2A1810)
private val EclipseInk = Color(0xFFF5E6D3)
private val EclipseAccent = Color(0xFFFF8C42)

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

private val EclipseColors = darkColorScheme(
    primary = EclipseAccent, onPrimary = EclipseBg,
    background = EclipseBg, onBackground = EclipseInk,
    surface = EclipseSurface, onSurface = EclipseInk,
    surfaceVariant = Color(0xFF3D2518), onSurfaceVariant = Color(0xFFC4A882),
    outline = Color(0xFF4D3020)
)

@Composable
fun RaveTheme(theme: String = "system", content: @Composable () -> Unit) {
    val dark = when (theme) {
        "light" -> false
        "dark", "eclipse" -> true
        else -> isSystemInDarkTheme()
    }
    val colors = when {
        theme == "eclipse" -> EclipseColors
        dark -> DarkColors
        else -> LightColors
    }
    MaterialTheme(colorScheme = colors, content = content)
}
