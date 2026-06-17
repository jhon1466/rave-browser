package com.rave.browser.ui

import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.rave.browser.browser.*
import org.json.JSONArray
import org.json.JSONObject

@Composable
fun EntryListDialog(
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
                            Text(e.title.ifBlank { e.url }, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(e.url, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (onDelete != null) {
                            IconButton(onClick = { onDelete(e) }) {
                                Icon(Icons.Default.Delete, "Eliminar", Modifier.size(20.dp))
                            }
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

@Composable
fun FindBar(
    visible: Boolean,
    onFind: (String, Boolean) -> Unit,
    onClose: () -> Unit
) {
    if (!visible) return
    var query by remember { mutableStateOf("") }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        OutlinedTextField(
            value = query, onValueChange = { query = it },
            placeholder = { Text("Buscar en la página") },
            singleLine = true, modifier = Modifier.weight(1f)
        )
        IconButton(onClick = { onFind(query, true) }) { Icon(Icons.Default.Search, "Buscar") }
        IconButton(onClick = { onFind(query, false) }) { Icon(Icons.Default.KeyboardArrowDown, "Siguiente") }
        IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Cerrar") }
    }
}

@Composable
fun SuggestionsDropdown(
    suggestions: List<Entry>,
    onSelect: (Entry) -> Unit
) {
    if (suggestions.isEmpty()) return
    Card(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp).heightIn(max = 240.dp),
        elevation = CardDefaults.cardElevation(4.dp)
    ) {
        LazyColumn {
            items(suggestions) { e ->
                Row(
                    Modifier.fillMaxWidth().clickable { onSelect(e) }.padding(12.dp)
                ) {
                    Column {
                        Text(e.title.ifBlank { e.url }, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(e.url, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

@Composable
fun BookmarksBar(entries: List<Entry>, onOpen: (String) -> Unit) {
    if (entries.isEmpty()) return
    LazyRow(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp)) {
        items(entries.take(12)) { e ->
            TextButton(onClick = { onOpen(e.url) }) {
                Text(e.title.ifBlank { e.url }, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 120.dp))
            }
        }
    }
}

@Composable
fun WelcomeDialog(
    onDismiss: () -> Unit,
    onSetDefaultBrowser: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Bienvenido a Rave") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "Rave es un navegador minimalista en blanco, negro y gris, " +
                        "con bloqueo de anuncios, pestañas, incógnito y privacidad integrada.",
                    style = MaterialTheme.typography.bodyMedium
                )
                Text(
                    "Puedes establecer Rave como navegador predeterminado para abrir enlaces " +
                        "desde otras apps automáticamente.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("Empezar") }
        },
        dismissButton = {
            TextButton(onClick = {
                onSetDefaultBrowser()
                onDismiss()
            }) { Text("Usar como predeterminado") }
        }
    )
}

@Composable
fun SettingsDialog(
    settings: AppSettings,
    isDefaultBrowser: Boolean,
    onSave: (AppSettings) -> Unit,
    onSetDefaultBrowser: () -> Unit,
    onExport: () -> Unit,
    onImport: () -> Unit,
    onClearData: () -> Unit,
    onDismiss: () -> Unit
) {
    var s by remember { mutableStateOf(settings) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Ajustes") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text("Navegador predeterminado", style = MaterialTheme.typography.labelMedium)
                Text(
                    if (isDefaultBrowser) "Rave es tu navegador predeterminado."
                    else "Rave no es el navegador predeterminado.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.height(6.dp))
                OutlinedButton(
                    onClick = onSetDefaultBrowser,
                    enabled = !isDefaultBrowser,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(if (isDefaultBrowser) "Ya es predeterminado" else "Establecer como predeterminado")
                }
                Spacer(Modifier.height(12.dp))
                HorizontalDivider()
                Spacer(Modifier.height(12.dp))
                Text("Motor de búsqueda", style = MaterialTheme.typography.labelMedium)
                listOf("ddg" to "DuckDuckGo", "google" to "Google", "bing" to "Bing", "brave" to "Brave", "ecosia" to "Ecosia").forEach { (k, label) ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = s.engine == k, onClick = { s = s.copy(engine = k) })
                        Text(label)
                    }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = s.homepage, onValueChange = { s = s.copy(homepage = it) },
                    label = { Text("Página de inicio (vacío = nueva pestaña)") },
                    singleLine = true, modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                Text("Tema", style = MaterialTheme.typography.labelMedium)
                listOf("system" to "Sistema", "light" to "Claro", "dark" to "Oscuro", "eclipse" to "Orange Eclipse").forEach { (k, label) ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = s.theme == k, onClick = { s = s.copy(theme = k) })
                        Text(label)
                    }
                }
                SettingSwitch("Barra de marcadores", s.showBookmarksBar) { s = s.copy(showBookmarksBar = it) }
                SettingSwitch("Animaciones", s.animations) { s = s.copy(animations = it) }
                SettingSwitch("Guardar contraseñas", s.savePasswords) { s = s.copy(savePasswords = it) }
                SettingSwitch("Solo HTTPS", s.httpsOnly) { s = s.copy(httpsOnly = it) }
                SettingSwitch("Bloqueo de anuncios", s.adBlock) { s = s.copy(adBlock = it) }
                SettingSwitch("Sitio de escritorio", s.desktopMode) { s = s.copy(desktopMode = it) }
                SettingSwitch("Borrar datos al salir", s.clearOnExit) { s = s.copy(clearOnExit = it) }
                Spacer(Modifier.height(8.dp))
                Text("Protección de rastreo", style = MaterialTheme.typography.labelMedium)
                listOf("off" to "Desactivada", "standard" to "Estándar", "strict" to "Estricta (DNT+GPC)").forEach { (k, label) ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = s.trackingLevel == k, onClick = { s = s.copy(trackingLevel = k) })
                        Text(label)
                    }
                }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = onExport) { Text("Exportar") }
                    TextButton(onClick = onImport) { Text("Importar") }
                    TextButton(onClick = onClearData) { Text("Borrar datos") }
                }
            }
        },
        confirmButton = { TextButton(onClick = { onSave(s); onDismiss() }) { Text("Guardar") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancelar") } }
    )
}

@Composable
private fun SettingSwitch(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
fun DownloadsDialog(entries: List<DownloadEntry>, onClear: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Descargas") },
        text = {
            if (entries.isEmpty()) Text("Sin descargas.")
            else LazyColumn(Modifier.heightIn(max = 400.dp)) {
                items(entries) { d ->
                    Column(Modifier.padding(vertical = 8.dp)) {
                        Text(d.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(d.path, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onClear) { Text("Limpiar lista") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cerrar") } }
    )
}

@Composable
fun PasswordsDialog(
    entries: List<PasswordEntry>,
    onAdd: (PasswordEntry) -> Unit,
    onDelete: (PasswordEntry) -> Unit,
    onDismiss: () -> Unit
) {
    var domain by remember { mutableStateOf("") }
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Contraseñas") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(domain, { domain = it }, label = { Text("Dominio") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(user, { user = it }, label = { Text("Usuario") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(pass, { pass = it }, label = { Text("Contraseña") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                TextButton(onClick = {
                    if (domain.isNotBlank() && user.isNotBlank()) {
                        onAdd(PasswordEntry(domain, user, pass))
                        domain = ""; user = ""; pass = ""
                    }
                }) { Text("Añadir") }
                Spacer(Modifier.height(8.dp))
                entries.forEach { e ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(e.domain, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(e.username, style = MaterialTheme.typography.bodySmall)
                        }
                        IconButton(onClick = { onDelete(e) }) { Icon(Icons.Default.Delete, null) }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cerrar") } }
    )
}

@Composable
fun CookiesDialog(url: String, cookies: List<Pair<String, String>>, onClearSite: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Cookies") },
        text = {
            if (cookies.isEmpty()) Text("Sin cookies para este sitio.")
            else LazyColumn(Modifier.heightIn(max = 360.dp)) {
                items(cookies) { (n, v) ->
                    Column(Modifier.padding(vertical = 6.dp)) {
                        Text(n, style = MaterialTheme.typography.labelMedium)
                        Text(v, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onClearSite) { Text("Borrar del sitio") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cerrar") } }
    )
}

@Composable
fun NotesDialog(notes: String, onChange: (String) -> Unit, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf(notes) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Notas") },
        text = {
            OutlinedTextField(
                value = text, onValueChange = { text = it; onChange(it) },
                modifier = Modifier.fillMaxWidth().height(240.dp)
            )
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cerrar") } }
    )
}

@Composable
fun SessionsDialog(
    sessions: List<SessionSnapshot>,
    onRestore: (SessionSnapshot) -> Unit,
    onDelete: (SessionSnapshot) -> Unit,
    onSaveCurrent: () -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Sesiones guardadas") },
        text = {
            Column {
                TextButton(onClick = onSaveCurrent) { Text("Guardar sesión actual") }
                if (sessions.isEmpty()) Text("Sin sesiones.")
                sessions.forEach { s ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f).clickable { onRestore(s) }) {
                            Text(s.name)
                            Text("${s.urls.size} pestañas", style = MaterialTheme.typography.bodySmall)
                        }
                        IconButton(onClick = { onDelete(s) }) { Icon(Icons.Default.Delete, null) }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cerrar") } }
    )
}

fun exportData(prefs: Prefs): String {
    val o = JSONObject()
    val bm = JSONArray()
    prefs.bookmarks().forEach { bm.put(JSONObject().put("title", it.title).put("url", it.url)) }
    val hm = JSONArray()
    prefs.history().forEach { hm.put(JSONObject().put("title", it.title).put("url", it.url)) }
    o.put("bookmarks", bm).put("history", hm)
    return o.toString(2)
}

fun importData(prefs: Prefs, json: String) {
    val o = JSONObject(json)
    val bm = o.optJSONArray("bookmarks")
    if (bm != null) {
        val list = mutableListOf<Entry>()
        for (i in 0 until bm.length()) {
            val e = bm.getJSONObject(i)
            list.add(Entry(e.optString("title"), e.optString("url")))
        }
        prefs.setBookmarks(list)
    }
    val hm = o.optJSONArray("history")
    if (hm != null) {
        val list = mutableListOf<Entry>()
        for (i in 0 until hm.length()) {
            val e = hm.getJSONObject(i)
            list.add(Entry(e.optString("title"), e.optString("url")))
        }
        prefs.setHistory(list)
    }
}

fun shareText(context: android.content.Context, text: String, title: String = "Rave") {
    context.startActivity(Intent.createChooser(
        Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, text) },
        title
    ))
}
