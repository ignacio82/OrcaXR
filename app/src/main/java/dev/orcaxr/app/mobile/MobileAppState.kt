package dev.orcaxr.app.mobile

import android.content.Context
import dev.orcaxr.app.CustomGcodeStore
import dev.orcaxr.app.FilamentEntriesStore
import dev.orcaxr.app.FilamentSlotsStore
import dev.orcaxr.app.MixedFilamentStore
import dev.orcaxr.app.PaintCacheStore
import dev.orcaxr.app.PlateStore
import dev.orcaxr.app.PrinterDiscovery
import dev.orcaxr.app.PrintersStore
import dev.orcaxr.app.RecentFilesStore
import dev.orcaxr.app.UserPreferences
import dev.orcaxr.app.UserProfilesStore
import dev.orcaxr.app.mcp.McpController
import dev.orcaxr.app.mcp.McpSettings
import dev.orcaxr.app.mcp.RemoteMcpStore

/**
 * Bundle of long-lived process-singletons the mobile UI reads from /
 * writes to. Created once in [dev.orcaxr.app.MobileActivity.onCreate]
 * and passed through CompositionLocal so individual screens don't have
 * to plumb a dozen named arguments. Mirrors what XR's [MainActivity]
 * holds as Activity-level fields, but exposed via a single struct so
 * MobileActivity stays small and screens stay testable.
 */
class MobileAppState(ctx: Context) {
    val app = ctx.applicationContext
    val prefs = UserPreferences(app)
    val userProfiles = UserProfilesStore(app)
    val printers = PrintersStore(app)
    val discovery = PrinterDiscovery(app)
    val filamentSlots = FilamentSlotsStore(app)
    val filamentEntries = FilamentEntriesStore(app)
    val mixedFilaments = MixedFilamentStore(app)
    val paintCache = PaintCacheStore(app)
    val recentFiles = RecentFilesStore(app)
    val plateStore = PlateStore(app)
    val customGcodeStore = CustomGcodeStore(app)
    val mcpSettings = McpSettings(app)
    val mcpController by lazy { McpController.get(app) }
    val remoteMcp = RemoteMcpStore(app)
}
