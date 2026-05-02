package dev.orcaxr.app.mcp

import android.content.Context
import dev.orcaxr.app.FilamentEntriesStore
import dev.orcaxr.app.FilamentSlotsStore
import dev.orcaxr.app.MixedFilamentStore
import dev.orcaxr.app.OrcaProfileLoader
import dev.orcaxr.app.PlateStore
import dev.orcaxr.app.PrintersStore
import dev.orcaxr.app.RecentFilesStore
import dev.orcaxr.app.SlicerProfile
import dev.orcaxr.app.UserPreferences
import dev.orcaxr.app.UserProfilesStore

/**
 * Bundled handle to the singleton stores tools need. Built once when
 * the server starts (so we don't construct a fresh DataStore per tool
 * call — DataStore enforces "one instance per file" anyway, and this
 * makes it explicit). Tools that need ephemeral state (current
 * placedModels, sliceState) reach into [WorkspaceModel] separately.
 */
class ToolContext(
    val appContext: Context,
    val printers: PrintersStore = PrintersStore(appContext),
    val profilesUser: UserProfilesStore = UserProfilesStore(appContext),
    val plates: PlateStore = PlateStore(appContext),
    val filamentEntries: FilamentEntriesStore = FilamentEntriesStore(appContext),
    val mixedFilaments: MixedFilamentStore = MixedFilamentStore(appContext),
    val filamentSlots: FilamentSlotsStore = FilamentSlotsStore(appContext),
    val recents: RecentFilesStore = RecentFilesStore(appContext),
    val prefs: UserPreferences = UserPreferences(appContext),
) {
    /**
     * The bundled-asset profile catalog (Snapmaker, Elegoo). User
     * profiles come from [profilesUser]; the merged "everything the
     * picker shows" view is bundled + user, ordered the same way the
     * UI orders them. Cached on first read since loadCatalog walks
     * the APK assets.
     */
    val bundledProfiles: List<SlicerProfile> by lazy {
        OrcaProfileLoader.loadCatalog(appContext)
    }
}
