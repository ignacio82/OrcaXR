package dev.orcaxr.nativeapp.project

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/**
 * Serves the copies of projects the operator shares, read-only, to the app
 * the share went to (which holds a one-time grant; the provider is not
 * exported). Only a file directly inside the app's `shared` cache folder is
 * served, by its exact name; nothing else on the device is reachable.
 */
class SharedProjects : ContentProvider() {
    companion object {
        private const val FOLDER = "shared"

        fun folder(context: Context): File = File(context.cacheDir, FOLDER)
        fun authority(context: Context) = "${context.packageName}.shared"
        fun uri(context: Context, file: File): Uri =
            Uri.Builder().scheme("content").authority(authority(context)).appendPath(file.name).build()
    }

    /** The shared copy [uri] names, or null for anything else. */
    private fun file(uri: Uri): File? {
        val context = context ?: return null
        val name = uri.pathSegments.singleOrNull() ?: return null
        if (name.isEmpty() || name == "." || name == ".." || '/' in name) return null
        return File(folder(context), name).takeIf { it.isFile && it.parentFile == folder(context) }
    }

    override fun onCreate() = true

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw FileNotFoundException("read only")
        val file = file(uri) ?: throw FileNotFoundException("not shared")
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? {
        val file = file(uri) ?: return null
        val columns = projection?.filter { it == OpenableColumns.DISPLAY_NAME || it == OpenableColumns.SIZE }?.toTypedArray()
            ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(columns, 1).apply {
            addRow(columns.map { if (it == OpenableColumns.DISPLAY_NAME) file.name else file.length() })
        }
    }

    override fun getType(uri: Uri): String? = file(uri)?.let { "model/3mf" }
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
