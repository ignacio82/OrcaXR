package dev.orcaxr.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FixPaletteTest {
    @Test
    fun fixPalette() = runBlocking {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val store = FilamentEntriesStore(ctx)
        val entries = listOf(
            FilamentEntry(id = "f_0", color = "#000000", slotIndex = 0), // Black -> Tag 1
            FilamentEntry(id = "f_1", color = "#FFFF00", slotIndex = 1), // Yellow -> Tag 2
            FilamentEntry(id = "f_2", color = "#FFFFFF", slotIndex = 2), // White -> Tag 3
            FilamentEntry(id = "f_3", color = "#FF0000", slotIndex = 3)  // Red -> Tag 4
        )
        store.set("printer_moz3jq6x", entries)
    }
}