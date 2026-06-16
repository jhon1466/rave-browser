package com.rave.browser

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.*
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import android.widget.Toast
import androidx.compose.runtime.rememberCoroutineScope
import com.rave.browser.browser.AdBlocker
import com.rave.browser.browser.Entry
import com.rave.browser.browser.Prefs
import com.rave.browser.browser.Updater
import com.rave.browser.ui.theme.RaveTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import java.net.URLEncoder

const val NEWTAB = "file:///android_asset/newtab.html"
private fun isInternal(url: String) = url.startsWith(NEWTAB)

private fun toUrl(input: String): String {
    val t = input.trim()
    if (t.isEmpty()) return NEWTAB
    if (t.matches(Regex("(?i)^[a-z]+://.*"))) return t
    if (t.contains('.') && !t.contains(' ')) return "https://$t"
    return "https://duckduckgo.com/?q=" + URLEncoder.encode(t, "UTF-8")
}

/** Estado observable de una pestaña (envuelve un WebView real). */
class TabModel(val webView: WebView, val incognito: Boolean) {
    var url by mutableStateOf(NEWTAB)
    var title by mutableStateOf("Nueva pestaña")
    var progress by mutableStateOf(0)
    var canBack by mutableStateOf(false)
    var canForward by mutableStateOf(false)
}

class MainActivity : ComponentActivity() {

    private val scope: CoroutineScope = MainScope()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AdBlocker.init(applicationContext, scope)
        setContent { RaveTheme { BrowserApp() } }
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun createTab(activity: ComponentActivity, prefs: Prefs, incognito: Boolean, startUrl: String): TabModel {
    val wv = WebView(activity)
    wv.layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
    )
    wv.settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        loadWithOverviewMode = true
        useWideViewPort = true
        builtInZoomControls = true
        displayZoomControls = false
        mediaPlaybackRequiresUserGesture = false
        // Quita el "; wv" para que los sitios no nos traten como un WebView básico.
        userAgentString = userAgentString.replace("; wv", "")
    }
    val tab = TabModel(wv, incognito)

    wv.webViewClient = object : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            AdBlocker.intercept(request.url?.toString())

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            tab.url = url
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            tab.url = url
            tab.canBack = view.canGoBack()
            tab.canForward = view.canGoForward()
        }

        override fun onPageFinished(view: WebView, url: String) {
            tab.url = url
            tab.title = view.title ?: url
            tab.canBack = view.canGoBack()
            tab.canForward = view.canGoForward()
            if (!incognito && !isInternal(url)) prefs.addHistory(Entry(tab.title, url))
        }
    }
    wv.webChromeClient = object : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) { tab.progress = newProgress }
        override fun onReceivedTitle(view: WebView, title: String?) { if (title != null) tab.title = title }
    }
    wv.loadUrl(startUrl)
    return tab
}

@Composable
fun BrowserApp() {
    val context = LocalContext.current
    val activity = context as ComponentActivity
    val prefs = remember { Prefs(context) }

    val tabs = remember { mutableStateListOf<TabModel>() }
    var active by remember { mutableIntStateOf(0) }
    var adBlock by remember { mutableStateOf(AdBlocker.enabled) }

    // Diálogos
    var showBookmarks by remember { mutableStateOf(false) }
    var showHistory by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }

    // Actualizaciones OTA
    val coroutine = rememberCoroutineScope()
    var update by remember { mutableStateOf<Updater.Info?>(null) }
    LaunchedEffect(Unit) { update = Updater.check(BuildConfig.VERSION_CODE) }

    fun openTab(incognito: Boolean = false, url: String = NEWTAB) {
        tabs.add(createTab(activity, prefs, incognito, url))
        active = tabs.lastIndex
    }
    fun closeTab(i: Int) {
        if (i !in tabs.indices) return
        tabs[i].webView.destroy()
        tabs.removeAt(i)
        if (tabs.isEmpty()) openTab()
        else if (active >= tabs.size) active = tabs.lastIndex
    }

    if (tabs.isEmpty()) openTab()
    val tab = tabs.getOrNull(active) ?: return

    // Botón atrás del sistema → atrás en la web o cerrar pestaña.
    BackHandler(enabled = true) {
        if (tab.webView.canGoBack()) tab.webView.goBack()
        else if (tabs.size > 1) closeTab(active)
    }

    Surface(color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {

            // ===== Barra de pestañas =====
            Row(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(start = 6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                LazyRow(Modifier.weight(1f)) {
                    itemsIndexed(tabs) { i, t ->
                        TabChip(
                            title = if (isInternal(t.url)) "Nueva pestaña" else t.title,
                            active = i == active,
                            incognito = t.incognito,
                            onClick = { active = i },
                            onClose = { closeTab(i) }
                        )
                    }
                }
                IconButton(onClick = { openTab() }) { Icon(Icons.Default.Add, "Nueva pestaña") }
            }

            // ===== Barra de navegación =====
            var query by remember(active, tab.url) {
                mutableStateOf(if (isInternal(tab.url)) "" else tab.url)
            }
            Row(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = 6.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(onClick = { if (tab.canBack) tab.webView.goBack() }, enabled = tab.canBack) {
                    Icon(Icons.Default.ArrowBack, "Atrás")
                }
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    singleLine = true,
                    placeholder = { Text("Busca o escribe una dirección") },
                    shape = RoundedCornerShape(24.dp),
                    modifier = Modifier.weight(1f),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { tab.webView.loadUrl(toUrl(query)) }),
                    leadingIcon = {
                        Icon(
                            if (tab.url.startsWith("https://")) Icons.Default.Lock else Icons.Default.Public,
                            contentDescription = null
                        )
                    }
                )
                IconButton(onClick = {
                    if (tab.progress in 1..99) tab.webView.stopLoading() else tab.webView.reload()
                }) {
                    Icon(if (tab.progress in 1..99) Icons.Default.Close else Icons.Default.Refresh, "Recargar")
                }
                Box {
                    IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, "Menú") }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("Nueva pestaña") }, onClick = { menuOpen = false; openTab() })
                        DropdownMenuItem(text = { Text("Pestaña de incógnito") }, onClick = { menuOpen = false; openTab(incognito = true) })
                        HorizontalDivider()
                        val marked = prefs.isBookmarked(tab.url)
                        DropdownMenuItem(
                            text = { Text(if (marked) "Quitar marcador" else "Añadir marcador") },
                            enabled = !isInternal(tab.url),
                            onClick = { menuOpen = false; prefs.toggleBookmark(Entry(tab.title, tab.url)) }
                        )
                        DropdownMenuItem(text = { Text("Marcadores") }, onClick = { menuOpen = false; showBookmarks = true })
                        DropdownMenuItem(text = { Text("Historial") }, onClick = { menuOpen = false; showHistory = true })
                        HorizontalDivider()
                        DropdownMenuItem(
                            text = { Text(if (adBlock) "Bloqueo de anuncios: ON" else "Bloqueo de anuncios: OFF") },
                            onClick = { adBlock = !adBlock; AdBlocker.enabled = adBlock; menuOpen = false }
                        )
                        DropdownMenuItem(text = { Text("Ir al inicio") }, onClick = { menuOpen = false; tab.webView.loadUrl(NEWTAB) })
                        DropdownMenuItem(text = { Text("Buscar actualizaciones") }, onClick = {
                            menuOpen = false
                            coroutine.launch {
                                val u = Updater.check(BuildConfig.VERSION_CODE)
                                if (u != null) update = u
                                else Toast.makeText(context, "Rave está actualizado", Toast.LENGTH_SHORT).show()
                            }
                        })
                    }
                }
            }

            // ===== Barra de progreso =====
            if (tab.progress in 1..99) {
                LinearProgressIndicator(
                    progress = { tab.progress / 100f },
                    modifier = Modifier.fillMaxWidth(),
                    color = MaterialTheme.colorScheme.onBackground,
                    trackColor = MaterialTheme.colorScheme.surface
                )
            }

            // ===== Página (WebView activo) =====
            AndroidView(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                factory = { FrameLayout(it) },
                update = { host ->
                    val wv = tab.webView
                    if (wv.parent !== host) {
                        (wv.parent as? ViewGroup)?.removeView(wv)
                        host.removeAllViews()
                        host.addView(wv)
                    }
                }
            )
        }
    }

    // ===== Diálogo de marcadores =====
    if (showBookmarks) {
        EntryListDialog(
            title = "Marcadores",
            entries = prefs.bookmarks(),
            onOpen = { tab.webView.loadUrl(it.url); showBookmarks = false },
            onDelete = { prefs.removeBookmark(it.url) },
            onDismiss = { showBookmarks = false }
        )
    }
    // ===== Diálogo de actualización OTA =====
    update?.let { info ->
        AlertDialog(
            onDismissRequest = { update = null },
            title = { Text("Actualización disponible") },
            text = { Text("Rave ${info.versionName}\n\n${info.notes}") },
            confirmButton = {
                TextButton(onClick = {
                    update = null
                    Toast.makeText(context, "Descargando actualización…", Toast.LENGTH_SHORT).show()
                    coroutine.launch {
                        val file = Updater.download(context, info.apkUrl)
                        if (file != null) Updater.install(context, file)
                        else Toast.makeText(context, "Error al descargar", Toast.LENGTH_SHORT).show()
                    }
                }) { Text("Actualizar") }
            },
            dismissButton = { TextButton(onClick = { update = null }) { Text("Ahora no") } }
        )
    }

    // ===== Diálogo de historial =====
    if (showHistory) {
        EntryListDialog(
            title = "Historial",
            entries = prefs.history(),
            onOpen = { tab.webView.loadUrl(it.url); showHistory = false },
            onDelete = null,
            onClearAll = { prefs.clearHistory(); showHistory = false },
            onDismiss = { showHistory = false }
        )
    }
}

@Composable
private fun TabChip(title: String, active: Boolean, incognito: Boolean, onClick: () -> Unit, onClose: () -> Unit) {
    Surface(
        color = if (active) MaterialTheme.colorScheme.background else MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(topStart = 10.dp, topEnd = 10.dp),
        modifier = Modifier.padding(end = 4.dp, top = 6.dp).widthIn(max = 170.dp).clickable { onClick() }
    ) {
        Row(Modifier.padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (incognito) {
                Icon(Icons.Default.Lock, null, Modifier.size(14.dp).padding(end = 4.dp))
            }
            Text(
                title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.labelLarge,
                color = if (active) MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f, fill = false)
            )
            IconButton(onClick = onClose, modifier = Modifier.size(24.dp)) {
                Icon(Icons.Default.Close, "Cerrar", Modifier.size(16.dp))
            }
        }
    }
}

@Composable
private fun EntryListDialog(
    title: String,
    entries: List<Entry>,
    onOpen: (Entry) -> Unit,
    onDelete: ((Entry) -> Unit)? = null,
    onClearAll: (() -> Unit)? = null,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            if (entries.isEmpty()) Text("Sin elementos.")
            else LazyColumn(Modifier.heightIn(max = 420.dp)) {
                items(entries) { e ->
                    Row(
                        Modifier.fillMaxWidth().clickable { onOpen(e) }.padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(e.title.ifBlank { e.url }, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                            Text(e.url, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        },
        confirmButton = {
            if (onClearAll != null) TextButton(onClick = onClearAll) { Text("Borrar todo") }
            else TextButton(onClick = onDismiss) { Text("Cerrar") }
        },
        dismissButton = { if (onClearAll != null) TextButton(onClick = onDismiss) { Text("Cerrar") } }
    )
}
