package dev.orcaxr.renderer

import dev.orcaxr.core.HelperVolumeRole
import dev.orcaxr.core.LocalTimestampResolver
import dev.orcaxr.core.PrimitiveShape
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectWorkspace
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** The Workspace's base colours as a renderer gets them from a real session
 * through [SceneSync], as the browser draws them (`volumeDisplayColor`): an
 * unassigned cube in the default surface colour; an object's physical
 * filament in that filament's colour and a mixed filament in its display
 * colour; a part's own filament over its object's; a modifier drawn like a
 * part, in its object's filament and then its own; a height range's filament
 * colouring nothing drawn; undo recolouring. Every change is a retint alone:
 * no mesh is sent again and no paint changes. */
object ProjectSceneColourChecks {
    private const val WAIT_S = 60L
    private const val BLUE = "0c792039-0d6d-4a46-93e8-2bbf4ca9af1e"
    private const val RED = "1089f201-ff94-437e-a01f-1aa18f170be0"
    private const val MIX = "de8102d0-aadb-4963-b472-d7613233db91"
    private const val RANGE = "5d4f0b8e-2c1a-4b7e-9f3d-6a2e8c1b0f47"

    @JvmStatic fun run(): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        fun units(text: String) = text.map { it.code }
        val absent = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)
        ProjectWorkspace(resolver = LocalTimestampResolver { it }).use { workspace ->
            workspace.ready().get(WAIT_S, TimeUnit.SECONDS)
            fun execute(command: ProjectIntents.Command) = workspace.execute(command).get(WAIT_S, TimeUnit.SECONDS)
            fun filament(objectId: String, id: String?) = execute(
                ProjectIntents.Command.SetObjectFilament(
                    ProjectIntents.SetObjectFilament(units(objectId), id?.let { ProjectIntents.OptionalId.Value(units(it)) } ?: ProjectIntents.OptionalId.Absent(ProjectIntents.Empty)),
                ),
            )
            fun partFilament(objectId: String, volumeId: String, id: String?) = execute(
                ProjectIntents.Command.SetVolumeFilament(
                    ProjectIntents.SetVolumeFilament(units(objectId), units(volumeId), id?.let { ProjectIntents.OptionalId.Value(units(it)) } ?: ProjectIntents.OptionalId.Absent(ProjectIntents.Empty)),
                ),
            )
            val updates = LinkedBlockingQueue<SceneSync.Update>()
            SceneSync(workspace) { updates.add(it) }.use { sync ->
                fun next(): SceneSync.Update {
                    sync.request()
                    return checkNotNull(updates.poll(WAIT_S, TimeUnit.SECONDS)) { "no scene update" }
                }
                fun retint(update: SceneSync.Update) = update.meshes.isEmpty() && update.removed.isEmpty() && update.paint.isEmpty()
                val cube = workspace.addPrimitive(PrimitiveShape.CUBE).get(WAIT_S, TimeUnit.SECONDS)!!
                execute(
                    ProjectIntents.Command.SyncPhysicalFilaments(
                        ProjectIntents.SyncPhysicalFilaments(
                            listOf(
                                ProjectIntents.PrinterSlot(0, units("#3366cc"), units("PLA"), absent, absent),
                                ProjectIntents.PrinterSlot(1, units("#cc3333"), units("PLA"), absent, absent),
                            ),
                            ProjectIntents.OptionalIds.Value(listOf(units(BLUE), units(RED))),
                        ),
                    ),
                )
                execute(
                    ProjectIntents.Command.AddMixedFilament(
                        ProjectIntents.AddMixedFilament(
                            ProjectIntents.MixedFilamentInput(
                                units(MIX), units("Purple mix"), units("#800080"),
                                listOf(ProjectIntents.MixedComponentInput(units(BLUE), 1.0), ProjectIntents.MixedComponentInput(units(RED), 1.0)),
                                ProjectIntents.MixedDistributionInput.Ratio(ProjectIntents.Empty),
                                ProjectIntents.OptionalFullSpectrum.Absent(ProjectIntents.Empty),
                                units("{}"), true, ProjectIntents.OptionalJsonText.Absent(ProjectIntents.Empty),
                            ),
                        ),
                    ),
                )
                val first = next().draws.single()
                val part = first.volumeId
                check(first.instanceId == cube.instanceId && first.argb == ProjectScene.DEFAULT_ARGB, "unassigned_default ${Integer.toHexString(first.argb)}")

                // An object's physical filament, then a mixed one: the draw retints, nothing else is sent.
                filament(cube.objectId, BLUE)
                val physical = next()
                check(physical.draws.single().argb == 0xff3366cc.toInt() && retint(physical), "object_physical")
                filament(cube.objectId, MIX)
                val mixed = next()
                check(mixed.draws.single().argb == 0xff800080.toInt() && retint(mixed), "object_mixed")

                // A part's own filament wins over its object's.
                partFilament(cube.objectId, part, RED)
                check(next().draws.single().argb == 0xffcc3333.toInt(), "part_over_object")

                // A modifier is drawn as a part is: its object's filament, then its own.
                workspace.selectInstance(cube.instanceId).get(WAIT_S, TimeUnit.SECONDS)
                val modifier = workspace.addHelperVolume(HelperVolumeRole.MODIFIER).get(WAIT_S, TimeUnit.SECONDS)!!.volumeId
                val helper = next().draws.single { it.volumeId == modifier }
                check(helper.role == ProjectIntents.VolumeRoleName.ParameterModifier && helper.argb == 0xff800080.toInt(), "modifier_takes_object ${Integer.toHexString(helper.argb)}")
                partFilament(cube.objectId, modifier, BLUE)
                val owned = next()
                check(owned.draws.single { it.volumeId == modifier }.argb == 0xff3366cc.toInt() && owned.draws.single { it.volumeId == part }.argb == 0xffcc3333.toInt(), "modifier_own")

                // A height range's filament colours nothing drawn, as in the browser.
                execute(ProjectIntents.Command.AddLayerRange(ProjectIntents.AddLayerRange(units(cube.objectId), units(RANGE), 2.0, 5.0)))
                val ranged = next().draws
                execute(
                    ProjectIntents.Command.SetLayerRangeFilament(
                        ProjectIntents.SetLayerRangeFilament(units(cube.objectId), units(RANGE), ProjectIntents.OptionalId.Value(units(BLUE))),
                    ),
                )
                val range = next()
                check(range.draws.map { it.key to it.argb } == ranged.map { it.key to it.argb } && retint(range), "range_colours_nothing")

                // Unassigned again, the part takes the default; undo brings its filament back.
                partFilament(cube.objectId, part, null)
                filament(cube.objectId, null)
                check(next().draws.single { it.volumeId == part }.argb == ProjectScene.DEFAULT_ARGB, "unassigned_again")
                workspace.undo().get(WAIT_S, TimeUnit.SECONDS)
                check(next().draws.single { it.volumeId == part }.argb == 0xff800080.toInt(), "undo_recolours")
            }
        }
        return checks
    }
}
