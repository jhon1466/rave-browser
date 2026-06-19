package com.rave.browser

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.print.PrintManager
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.rave.browser.browser.*
import com.rave.browser.ui.*
import com.rave.browser.ui.theme.RaveTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val scope: CoroutineScope = MainScope()
    private var deepLinkUrl = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        deepLinkUrl.value = extractUrl(intent)
        val s = SettingsStore.load(this)
        AdBlocker.enabled = s.adBlock
        AdBlocker.init(applicationContext, scope)
        setContent {
            val link by deepLinkUrl
            val settings = remember { mutableStateOf(SettingsStore.load(this)) }
            RaveTheme(theme = settings.value.theme) {
                BrowserApp(
                    initialUrl = link,
                    onDeepLink = { deepLinkUrl.value = it },
                    settings = settings.value,
                    onSettingsChange = { s ->
                        settings.value = s
                        SettingsStore.save(this, s)
                        AdBlocker.enabled = s.adBlock
                    },
                    onClearExit = {
                        if (settings.value.clearOnExit) clearBrowserData(this)
                    }
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        deepLinkUrl.value = extractUrl(intent)
    }

    private fun extractUrl(intent: Intent?): String? {
        val data = intent?.data ?: return null
        if (data.scheme == "http" || data.scheme == "https") return data.toString()
        return null
    }
}

@Composable
fun BrowserApp(
    initialUrl: String? = null,
    onDeepLink: (String?) -> Unit = {},
    settings: AppSettings,
    onSettingsChange: (AppSettings) -> Unit,
    onClearExit: () -> Unit = {}
) {
    val context = LocalContext.current
    val activity = context as ComponentActivity
    val prefs = remember { Prefs(context) }
    val secure = remember { SecureStore(context) }
    val sitePerms = remember { SitePermissions(context) }
    val coroutine = rememberCoroutineScope()

    val tabs = remember { mutableStateListOf<TabModel>() }
    var active by remember { mutableIntStateOf(0) }
    val closedTabs = remember { mutableStateListOf<Pair<String, Boolean>>() }

    var showBookmarks by remember { mutableStateOf(false) }
    var showHistory by remember { mutableStateOf(false) }
    var showDownloads by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    var showWelcome by remember { mutableStateOf(!SettingsStore.hasSeenWelcome(context)) }
    var showPasswords by remember { mutableStateOf(false) }
    var showCookies by remember { mutableStateOf(false) }
    var showNotes by remember { mutableStateOf(false) }
    var showSessions by remember { mutableStateOf(false) }
    var showFind by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    var update by remember { mutableStateOf<Updater.Info?>(null) }
    var fileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    var refreshKey by remember { mutableIntStateOf(0) }
    var permissionPrompt by remember { mutableStateOf<PermissionPrompt?>(null) }
    var pendingGrant by remember { mutableStateOf<((Boolean) -> Unit)?>(null) }

    val fileLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val cb = fileCallback ?: return@rememberLauncherForActivityResult
        fileCallback = null
        val uris = WebChromeClientFileChooser.parseResult(result.resultCode, result.data)
        cb.onReceiveValue(uris)
    }

    val defaultBrowserLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { _ -> }

    fun requestDefaultBrowser() {
        val intent = DefaultBrowser.createRequestIntent(context)
        if (intent != null) defaultBrowserLauncher.launch(intent)
        else Toast.makeText(context, "Rave ya es el navegador predeterminado", Toast.LENGTH_SHORT).show()
    }

    // Pide a una web los permisos del SO que faltan; al resolverse, concede o
    // deniega también el permiso web a través de pendingGrant.
    val runtimePermLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        val granted = result.values.all { it }
        pendingGrant?.invoke(granted)
        pendingGrant = null
    }

    // Concede el permiso web asegurando primero el permiso runtime del SO.
    fun grantWithOsPermission(prompt: PermissionPrompt) {
        val missing = prompt.osPermissions.filter {
            ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) prompt.onResult(true)
        else {
            pendingGrant = prompt.onResult
            runtimePermLauncher.launch(missing.toTypedArray())
        }
    }

    // Decide qué hacer con una solicitud de permiso: respetar la decisión
    // recordada o mostrar el diálogo de consentimiento.
    fun handlePermission(prompt: PermissionPrompt) {
        when (sitePerms.decision(prompt.origin, prompt.osPermissions)) {
            false -> prompt.onResult(false)
            true -> grantWithOsPermission(prompt)
            null -> permissionPrompt = prompt
        }
    }

    fun openTabInternal(
        tabList: MutableList<TabModel>,
        p: Prefs,
        s: AppSettings,
        incognito: Boolean,
        url: String,
        after: () -> Unit = {}
    ) {
        val start = if (url == NEWTAB || url.startsWith(NEWTAB)) newTabUrl(s, p.topSites()) else url
        val ua = if (s.desktopMode) {
            val sample = WebView(context).settings.userAgentString
            desktopUserAgent(sample)
        } else null
        val cb = WebViewCallbacks(
            onPopup = { popupUrl ->
                openTabInternal(tabList, p, s, false, popupUrl) {
                    if (tabList === tabs) active = tabs.lastIndex
                }
            },
            onDownload = { dlUrl, dlUa, cd, mime ->
                DownloadHelper.enqueue(context, dlUrl, dlUa, cd, mime) { prefs.addDownload(it) }
                Toast.makeText(context, "Descarga iniciada", Toast.LENGTH_SHORT).show()
            },
            onFileChooser = { callback, params ->
                fileCallback = callback
                fileLauncher.launch(params.createIntent())
                true
            },
            onPermission = { prompt -> handlePermission(prompt) }
        )
        tabList.add(createTab(activity, p, s, incognito, start, cb, ua))
        after()
    }

    fun openTab(incognito: Boolean = false, url: String = NEWTAB) {
        openTabInternal(tabs, prefs, settings, incognito, url) { active = tabs.lastIndex }
    }

    fun closeTab(i: Int) {
        if (i !in tabs.indices) return
        val t = tabs[i]
        if (!t.url.let { isInternal(it) }) closedTabs.add(0, t.url to t.incognito)
        if (t.incognito) {
            t.webView.clearCache(true)
            android.webkit.CookieManager.getInstance().removeSessionCookies(null)
        }
        t.webView.destroy()
        tabs.removeAt(i)
        if (tabs.isEmpty()) openTab()
        else if (active >= tabs.size) active = tabs.lastIndex
    }

    // Restaurar sesión, enlace externo o primera pestaña
    LaunchedEffect(Unit) {
        update = Updater.check(BuildConfig.VERSION_CODE)
        if (tabs.isEmpty()) {
            when {
                initialUrl != null -> openTab(url = initialUrl)
                prefs.tabSession().isNotEmpty() -> {
                    prefs.tabSession().forEach { snap ->
                        openTabInternal(tabs, prefs, settings, snap.incognito, snap.url) {}
                    }
                    active = prefs.activeTabIndex().coerceIn(0, tabs.lastIndex)
                }
                else -> openTab()
            }
        }
    }

    LaunchedEffect(initialUrl) {
        initialUrl?.let { url ->
            if (tabs.isNotEmpty()) {
                openTab(url = url)
                onDeepLink(null)
            }
        }
    }

    if (tabs.isEmpty()) return
    val tab = tabs[active]

    DisposableEffect(Unit) {
        onDispose {
            prefs.saveTabSession(
                tabs.map { TabSnapshot(it.url, it.incognito, it.pinned) },
                active
            )
            onClearExit()
        }
    }

    BackHandler {
        if (showFind) showFind = false
        else if (tab.webView.canGoBack()) tab.webView.goBack()
        else if (tabs.size > 1) closeTab(active)
    }

    val sortedIndices = tabs.indices.sortedWith(compareBy({ !tabs[it].pinned }, { it }))

    Surface(color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {

            // Pestañas
            Row(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(start = 6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                LazyRow(Modifier.weight(1f)) {
                    itemsIndexed(sortedIndices) { _, i ->
                        val t = tabs[i]
                        TabChip(
                            title = if (isInternal(t.url)) "Nueva pestaña" else t.title,
                            active = i == active,
                            incognito = t.incognito,
                            pinned = t.pinned,
                            onClick = { active = i },
                            onClose = { closeTab(i) }
                        )
                    }
                }
                IconButton(onClick = { openTab() }) { Icon(Icons.Default.Add, "Nueva pestaña") }
            }

            // Barra de marcadores
            if (settings.showBookmarksBar) {
                BookmarksBar(prefs.bookmarks()) { tab.webView.loadUrl(it) }
            }

            // Navegación
            var query by remember(active, tab.url) {
                mutableStateOf(if (isInternal(tab.url)) "" else tab.url)
            }
            var suggestions by remember { mutableStateOf<List<Entry>>(emptyList()) }

            Row(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = 4.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(onClick = { if (tab.canBack) tab.webView.goBack() }, enabled = tab.canBack) {
                    Icon(Icons.Default.ArrowBack, "Atrás")
                }
                IconButton(onClick = { if (tab.canForward) tab.webView.goForward() }, enabled = tab.canForward) {
                    Icon(Icons.Default.ArrowForward, "Adelante")
                }
                OutlinedTextField(
                    value = query,
                    onValueChange = {
                        query = it
                        suggestions = buildSuggestions(it, prefs)
                    },
                    singleLine = true,
                    placeholder = { Text("Busca o escribe una dirección") },
                    shape = RoundedCornerShape(24.dp),
                    modifier = Modifier.weight(1f),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = {
                        suggestions = emptyList()
                        tab.webView.loadUrl(toUrl(query, settings), extraHeaders(settings))
                    }),
                    leadingIcon = {
                        Icon(
                            if (tab.url.startsWith("https://")) Icons.Default.Lock else Icons.Default.Public,
                            contentDescription = null, Modifier.size(18.dp)
                        )
                    },
                    trailingIcon = {
                        val marked = prefs.isBookmarked(tab.url)
                        IconButton(onClick = {
                            if (!isInternal(tab.url)) prefs.toggleBookmark(Entry(tab.title, tab.url))
                        }, enabled = !isInternal(tab.url)) {
                            Icon(
                                if (marked) Icons.Default.Star else Icons.Default.StarBorder,
                                "Marcador", tint = if (marked) MaterialTheme.colorScheme.primary else LocalContentColor.current
                            )
                        }
                    }
                )
                // Escudo anti-anuncios
                BadgedBox(badge = {
                    if (AdBlocker.blockedCount > 0) Badge { Text("${AdBlocker.blockedCount.coerceAtMost(999)}") }
                }) {
                    Icon(Icons.Default.Shield, "Escudo", Modifier.padding(8.dp).size(20.dp))
                }
                IconButton(onClick = {
                    if (tab.progress in 1..99) tab.webView.stopLoading() else tab.webView.reload()
                }) {
                    Icon(if (tab.progress in 1..99) Icons.Default.Close else Icons.Default.Refresh, "Recargar")
                }
                Box {
                    IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, "Menú") }
                    BrowserMenu(
                        expanded = menuOpen,
                        onDismiss = { menuOpen = false },
                        settings = settings,
                        tabIncognito = tab.incognito,
                        isInternal = isInternal(tab.url),
                        bookmarked = prefs.isBookmarked(tab.url),
                        onNewTab = { openTab() },
                        onIncognito = { openTab(incognito = true) },
                        onReopenClosed = {
                            val c = closedTabs.removeFirstOrNull() ?: return@BrowserMenu
                            openTab(c.second, c.first)
                        },
                        onDuplicate = { openTab(tab.incognito, tab.url) },
                        onPin = {
                            tab.pinned = !tab.pinned
                            refreshKey++
                        },
                        pinned = tab.pinned,
                        onCloseOthers = {
                            val keep = tab.url
                            val inc = tab.incognito
                            tabs.indices.toList().reversed().forEach { if (it != active) closeTab(it) }
                            active = 0
                        },
                        onBookmark = {
                            if (!tab.incognito) prefs.toggleBookmark(Entry(tab.title, tab.url))
                        },
                        onShare = { shareText(context, tab.url) },
                        onFind = { showFind = true },
                        onReader = { tab.webView.evaluateJavascript(ReaderMode.CSS, null) },
                        onScreenshot = {
                            captureWebView(tab.webView, context)
                            Toast.makeText(context, "Captura guardada", Toast.LENGTH_SHORT).show()
                        },
                        onPrint = {
                            (context.getSystemService(android.content.Context.PRINT_SERVICE) as PrintManager)
                                .print("Rave", tab.webView.createPrintDocumentAdapter("Rave"), null)
                        },
                        onZoomIn = { tab.webView.settings.textZoom = (tab.webView.settings.textZoom + 10).coerceAtMost(300); tab.zoom = tab.webView.settings.textZoom },
                        onZoomOut = { tab.webView.settings.textZoom = (tab.webView.settings.textZoom - 10).coerceAtLeast(50); tab.zoom = tab.webView.settings.textZoom },
                        onZoomReset = { tab.webView.settings.textZoom = 100; tab.zoom = 100 },
                        onHome = { tab.webView.loadUrl(homeUrl(settings, prefs.topSites())) },
                        onBookmarks = { showBookmarks = true },
                        onHistory = { showHistory = true },
                        onDownloads = { showDownloads = true },
                        onPasswords = { showPasswords = true },
                        onCookies = { showCookies = true },
                        onNotes = { showNotes = true },
                        onSessions = { showSessions = true },
                        onSettings = { showSettings = true },
                        onToggleAdblock = {
                            onSettingsChange(settings.copy(adBlock = !settings.adBlock))
                        },
                        onToggleDesktop = {
                            onSettingsChange(settings.copy(desktopMode = !settings.desktopMode))
                            Toast.makeText(context, "Reinicia la pestaña para aplicar", Toast.LENGTH_SHORT).show()
                        },
                        onCheckUpdate = {
                            coroutine.launch {
                                val u = Updater.check(BuildConfig.VERSION_CODE)
                                if (u != null) update = u
                                else Toast.makeText(context, "Rave está actualizado", Toast.LENGTH_SHORT).show()
                            }
                        }
                    )
                }
            }

            if (suggestions.isNotEmpty()) {
                SuggestionsDropdown(suggestions) { e ->
                    suggestions = emptyList()
                    query = e.url
                    tab.webView.loadUrl(e.url)
                }
            }

            FindBar(showFind, { q, forward ->
                if (forward) tab.webView.findAllAsync(q) else tab.webView.findNext(forward)
            }) { showFind = false; tab.webView.clearMatches() }

            if (tab.progress in 1..99) {
                LinearProgressIndicator(
                    progress = { tab.progress / 100f },
                    modifier = Modifier.fillMaxWidth(),
                    color = MaterialTheme.colorScheme.onBackground,
                    trackColor = MaterialTheme.colorScheme.surface
                )
            }

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

    // Diálogos
    if (showBookmarks) EntryListDialog("Marcadores", prefs.bookmarks(),
        onOpen = { tab.webView.loadUrl(it.url); showBookmarks = false },
        onDelete = { prefs.removeBookmark(it.url) },
        onDismiss = { showBookmarks = false })

    if (showHistory) EntryListDialog("Historial", prefs.history(),
        onOpen = { tab.webView.loadUrl(it.url); showHistory = false },
        onDelete = { prefs.removeHistory(it.url) },
        onClearAll = { prefs.clearHistory(); showHistory = false },
        onDismiss = { showHistory = false })

    if (showDownloads) DownloadsDialog(prefs.downloads(),
        onClear = { prefs.clearDownloads() },
        onDismiss = { showDownloads = false })

    if (showSettings) SettingsDialog(
        settings = settings,
        isDefaultBrowser = DefaultBrowser.isDefault(context),
        onSave = onSettingsChange,
        onSetDefaultBrowser = { requestDefaultBrowser() },
        onExport = { shareText(context, exportData(prefs), "Exportar datos Rave") },
        onImport = { Toast.makeText(context, "Usa exportar/importar JSON", Toast.LENGTH_SHORT).show() },
        onClearData = {
            prefs.clearHistory(); prefs.setBookmarks(emptyList()); prefs.clearDownloads()
            prefs.setNotes(""); clearBrowserData(activity)
            Toast.makeText(context, "Datos borrados", Toast.LENGTH_SHORT).show()
        },
        onDismiss = { showSettings = false }
    )

    if (showWelcome) {
        WelcomeDialog(
            onDismiss = {
                SettingsStore.setWelcomeSeen(context)
                showWelcome = false
            },
            onSetDefaultBrowser = { requestDefaultBrowser() }
        )
    }

    if (showPasswords) PasswordsDialog(secure.passwords(),
        onAdd = { secure.addPassword(it) },
        onDelete = { secure.removePassword(it.domain, it.username) },
        onDismiss = { showPasswords = false })

    if (showCookies) CookiesDialog(tab.url, siteCookies(tab.url),
        onClearSite = { clearSiteCookies(tab.url); showCookies = false },
        onDismiss = { showCookies = false })

    if (showNotes) NotesDialog(prefs.notes(), { prefs.setNotes(it) }, { showNotes = false })

    if (showSessions) SessionsDialog(prefs.sessions(),
        onRestore = { snap ->
            snap.urls.forEach { openTab(false, it) }
            showSessions = false
        },
        onDelete = { prefs.removeSession(it.name) },
        onSaveCurrent = {
            prefs.addSession(SessionSnapshot("Sesión ${System.currentTimeMillis()}", tabs.map { it.url }))
            Toast.makeText(context, "Sesión guardada", Toast.LENGTH_SHORT).show()
        },
        onDismiss = { showSessions = false })

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

    permissionPrompt?.let { prompt ->
        var rememberChoice by remember(prompt) { mutableStateOf(true) }
        AlertDialog(
            onDismissRequest = { prompt.onResult(false); permissionPrompt = null },
            title = { Text("Permiso solicitado") },
            text = {
                Column {
                    Text("${prompt.origin} quiere usar: ${prompt.labels.joinToString(", ")}")
                    Spacer(Modifier.height(12.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.clickable { rememberChoice = !rememberChoice }
                    ) {
                        Checkbox(checked = rememberChoice, onCheckedChange = { rememberChoice = it })
                        Text("Recordar para este sitio")
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    if (rememberChoice) sitePerms.remember(prompt.origin, prompt.osPermissions, true)
                    permissionPrompt = null
                    grantWithOsPermission(prompt)
                }) { Text("Permitir") }
            },
            dismissButton = {
                TextButton(onClick = {
                    if (rememberChoice) sitePerms.remember(prompt.origin, prompt.osPermissions, false)
                    prompt.onResult(false)
                    permissionPrompt = null
                }) { Text("Bloquear") }
            }
        )
    }
}

private fun buildSuggestions(q: String, prefs: Prefs): List<Entry> {
    if (q.length < 2) return emptyList()
    val lq = q.lowercase()
    val out = LinkedHashSet<Entry>()
    prefs.bookmarks().filter { it.title.lowercase().contains(lq) || it.url.lowercase().contains(lq) }.take(4).forEach { out.add(it) }
    prefs.history().filter { it.title.lowercase().contains(lq) || it.url.lowercase().contains(lq) }.take(4).forEach { out.add(it) }
    return out.take(8).toList()
}

@Composable
private fun BrowserMenu(
    expanded: Boolean,
    onDismiss: () -> Unit,
    settings: AppSettings,
    tabIncognito: Boolean,
    isInternal: Boolean,
    bookmarked: Boolean,
    pinned: Boolean,
    onNewTab: () -> Unit,
    onIncognito: () -> Unit,
    onReopenClosed: () -> Unit,
    onDuplicate: () -> Unit,
    onPin: () -> Unit,
    onCloseOthers: () -> Unit,
    onBookmark: () -> Unit,
    onShare: () -> Unit,
    onFind: () -> Unit,
    onReader: () -> Unit,
    onScreenshot: () -> Unit,
    onPrint: () -> Unit,
    onZoomIn: () -> Unit,
    onZoomOut: () -> Unit,
    onZoomReset: () -> Unit,
    onHome: () -> Unit,
    onBookmarks: () -> Unit,
    onHistory: () -> Unit,
    onDownloads: () -> Unit,
    onPasswords: () -> Unit,
    onCookies: () -> Unit,
    onNotes: () -> Unit,
    onSessions: () -> Unit,
    onSettings: () -> Unit,
    onToggleAdblock: () -> Unit,
    onToggleDesktop: () -> Unit,
    onCheckUpdate: () -> Unit
) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        DropdownMenuItem({ Text("Nueva pestaña") }, { onDismiss(); onNewTab() })
        DropdownMenuItem({ Text("Pestaña de incógnito") }, { onDismiss(); onIncognito() })
        DropdownMenuItem({ Text("Reabrir pestaña cerrada") }, { onDismiss(); onReopenClosed() })
        DropdownMenuItem({ Text("Duplicar pestaña") }, { onDismiss(); onDuplicate() })
        DropdownMenuItem({ Text(if (pinned) "Desfijar pestaña" else "Fijar pestaña") }, { onDismiss(); onPin() })
        DropdownMenuItem({ Text("Cerrar otras pestañas") }, { onDismiss(); onCloseOthers() })
        HorizontalDivider()
        DropdownMenuItem({ Text(if (bookmarked) "Quitar marcador" else "Añadir marcador") }, { onDismiss(); onBookmark() }, enabled = !isInternal && !tabIncognito)
        DropdownMenuItem({ Text("Compartir página") }, { onDismiss(); onShare() }, enabled = !isInternal)
        DropdownMenuItem({ Text("Buscar en la página") }, { onDismiss(); onFind() })
        DropdownMenuItem({ Text("Modo lectura") }, { onDismiss(); onReader() })
        DropdownMenuItem({ Text("Captura de pantalla") }, { onDismiss(); onScreenshot() })
        DropdownMenuItem({ Text("Imprimir") }, { onDismiss(); onPrint() })
        HorizontalDivider()
        DropdownMenuItem({ Text("Zoom +") }, { onDismiss(); onZoomIn() })
        DropdownMenuItem({ Text("Zoom −") }, { onDismiss(); onZoomOut() })
        DropdownMenuItem({ Text("Zoom 100%") }, { onDismiss(); onZoomReset() })
        HorizontalDivider()
        DropdownMenuItem({ Text("Marcadores") }, { onDismiss(); onBookmarks() })
        DropdownMenuItem({ Text("Historial") }, { onDismiss(); onHistory() })
        DropdownMenuItem({ Text("Descargas") }, { onDismiss(); onDownloads() })
        DropdownMenuItem({ Text("Contraseñas") }, { onDismiss(); onPasswords() })
        DropdownMenuItem({ Text("Cookies") }, { onDismiss(); onCookies() })
        DropdownMenuItem({ Text("Notas") }, { onDismiss(); onNotes() })
        DropdownMenuItem({ Text("Sesiones") }, { onDismiss(); onSessions() })
        DropdownMenuItem({ Text("Ajustes") }, { onDismiss(); onSettings() })
        HorizontalDivider()
        DropdownMenuItem({ Text(if (settings.adBlock) "Bloqueo de anuncios: ON" else "Bloqueo de anuncios: OFF") }, { onDismiss(); onToggleAdblock() })
        DropdownMenuItem({ Text(if (settings.desktopMode) "Sitio de escritorio: ON" else "Sitio de escritorio: OFF") }, { onDismiss(); onToggleDesktop() })
        DropdownMenuItem({ Text("Ir al inicio") }, { onDismiss(); onHome() })
        DropdownMenuItem({ Text("Buscar actualizaciones") }, { onDismiss(); onCheckUpdate() })
    }
}

@Composable
private fun TabChip(title: String, active: Boolean, incognito: Boolean, pinned: Boolean, onClick: () -> Unit, onClose: () -> Unit) {
    Surface(
        color = if (active) MaterialTheme.colorScheme.background else MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(topStart = 10.dp, topEnd = 10.dp),
        modifier = Modifier.padding(end = 4.dp, top = 6.dp).widthIn(max = 170.dp).clickable { onClick() }
    ) {
        Row(Modifier.padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (incognito) Icon(Icons.Default.Lock, null, Modifier.size(14.dp).padding(end = 2.dp))
            if (pinned) Icon(Icons.Default.PushPin, null, Modifier.size(14.dp).padding(end = 2.dp))
            Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.labelLarge,
                color = if (active) MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f, fill = false))
            IconButton(onClick = onClose, modifier = Modifier.size(24.dp)) {
                Icon(Icons.Default.Close, "Cerrar", Modifier.size(16.dp))
            }
        }
    }
}

private object WebChromeClientFileChooser {
    fun parseResult(resultCode: Int, data: Intent?): Array<Uri>? {
        if (resultCode != Activity.RESULT_OK || data == null) return null
        val clip = data.clipData
        if (clip != null) {
            return Array(clip.itemCount) { clip.getItemAt(it).uri }
        }
        data.data?.let { return arrayOf(it) }
        return null
    }
}

private fun captureWebView(wv: WebView, context: android.content.Context) {
    try {
        val bmp = android.graphics.Bitmap.createBitmap(wv.width, wv.height, android.graphics.Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(bmp)
        wv.draw(canvas)
        val file = java.io.File(context.cacheDir, "rave-screenshot-${System.currentTimeMillis()}.png")
        java.io.FileOutputStream(file).use { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        shareText(context, file.absolutePath, "Captura Rave")
    } catch (_: Exception) {}
}
