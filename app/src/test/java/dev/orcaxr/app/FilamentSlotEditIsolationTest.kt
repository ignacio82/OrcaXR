package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pin the per-slot mutation invariants for the Phase J ColorMappingPanel
 * helpers. Two things this test guards:
 *
 *  1. Editing one slot must NEVER bleed into another — the Snapmaker
 *     desktop fork's `ExtruderOptionsGroup::on_change_OG()` write-broadcast
 *     bug (per-extruder edits leaking into all extruders' configs in fork
 *     PR #160's GUI half) is the class of regression we're guarding
 *     against.
 *  2. The Phase J shape: color edits and mapping edits are independent.
 *     Pre-Phase J, picking a printer-slot swatch in the picker bundled a
 *     color update with the mapping change — and a manual hex edit
 *     silently CLEARED the mapping, which is what made the dragon-3MF
 *     bug (purple body printed black) so easy to hit. The new helpers in
 *     [MainActivity.applyChangeColor] et al. do exactly one thing each.
 *
 * The tests reach into the production helpers directly instead of
 * mirroring them — that's deliberate, so a refactor that drifts the
 * lambda body trips the test rather than the test silently re-validating
 * its own copy.
 */
class FilamentSlotEditIsolationTest {

    private fun baseList() = listOf(
        FilamentEntry(id = "s0", color = "#FF0000", slotIndex = 0, filamentType = "PLA"),
        FilamentEntry(id = "s1", color = "#00FF00", slotIndex = 1, filamentType = "PLA"),
        FilamentEntry(id = "s2", color = "#0000FF", slotIndex = 2, filamentType = "PLA"),
        FilamentEntry(id = "s3", color = "#FFFFFF", slotIndex = 3, filamentType = "PLA"),
    )

    @Test fun changeColorOnSlot1LeavesOthersUntouched() {
        val before = baseList()
        val after = applyChangeColor(before, slot = 1, hex = "#ABCDEF")
        assertEquals(before[0], after[0])
        assertEquals(before[2], after[2])
        assertEquals(before[3], after[3])
        assertEquals("#ABCDEF", after[1].color)
        assertEquals(before[1].slotIndex, after[1].slotIndex)
        assertEquals(before[1].filamentType, after[1].filamentType)
    }

    @Test fun changeColorPreservesPhysicalAndVirtualMappingOnTargetRow() {
        // Phase J semantic shift: the model row's color edit is
        // cosmetic-only. The user keeps printing from T2 even after
        // tweaking the swatch shade, because the right-side mapping
        // chip is what they would tap to redirect a print.
        val before = listOf(
            baseList()[0].copy(physicalSlot = 2),
            baseList()[1].copy(virtualSlot = 1),
            baseList()[2],
            baseList()[3],
        )
        val after = applyChangeColor(before, slot = 0, hex = "#001122")
        assertEquals("#001122", after[0].color)
        assertEquals(2, after[0].physicalSlot)
        assertEquals(1, after[1].virtualSlot)
    }

    @Test fun mapToPhysicalSetsPhysicalAndClearsVirtual() {
        // Pre-existing virtualSlot on the target row must be cleared
        // when the user re-points the row at a physical slot — the two
        // remap fields are mutually exclusive.
        val before = baseList().mapIndexed { i, f ->
            if (i == 2) f.copy(virtualSlot = 1) else f
        }
        val after = applyMapToPhysical(before, slot = 2, physicalSlot = 1)
        assertEquals(1, after[2].physicalSlot)
        assertNull(after[2].virtualSlot)
    }

    @Test fun mapToPhysicalDoesNotChangeColor() {
        // Before Phase J, picking a printer-slot swatch in the picker
        // also rewrote the row's color to that swatch. That conflated
        // "what color the model wants" with "where it prints from"
        // and was the source of the dragon bug. The new pure helper
        // touches mapping only.
        val before = baseList()
        val after = applyMapToPhysical(before, slot = 0, physicalSlot = 1)
        assertEquals(before[0].color, after[0].color)
        assertEquals(1, after[0].physicalSlot)
    }

    @Test fun mapToPhysicalLeavesOtherSlotsUntouched() {
        val before = baseList().mapIndexed { i, f ->
            if (i == 0) f.copy(physicalSlot = 3) else f
        }
        val after = applyMapToPhysical(before, slot = 2, physicalSlot = 1)
        // Slot 0's pre-existing remap survives — different physical
        // target so no collision-bump is required.
        assertEquals(3, after[0].physicalSlot)
        assertEquals(1, after[2].physicalSlot)
        assertNull(after[1].physicalSlot)
        assertNull(after[3].physicalSlot)
    }

    @Test fun mapToPhysicalBumpsPriorOccupant() {
        // Two project filaments must NEVER share a physical extruder.
        // Pre-fix the picker silently let the user create the collision,
        // and libslic3r's filament_map collapsed the painted regions of
        // both rows onto the same Tn — the dragon-3MF body printed in
        // 2 colors instead of 4 (DragonColorDiagTest covers the JNI half).
        // Tapping "T0 for slot 1" must clear any prior occupant of T0.
        val before = baseList().mapIndexed { i, f ->
            if (i == 0) f.copy(physicalSlot = 0) else f
        }
        val after = applyMapToPhysical(before, slot = 1, physicalSlot = 0)
        assertEquals(0, after[1].physicalSlot)
        assertNull(after[0].physicalSlot)
        // Untouched rows stay null.
        assertNull(after[2].physicalSlot)
        assertNull(after[3].physicalSlot)
    }

    @Test fun mapToPhysicalSelfMapDoesNotBumpItself() {
        // Re-asserting the same physical for the same slot must not
        // trip the bump branch on the target row — the i == slot match
        // is the new assignment, not a collision with itself.
        val before = baseList().mapIndexed { i, f ->
            if (i == 1) f.copy(physicalSlot = 2) else f
        }
        val after = applyMapToPhysical(before, slot = 1, physicalSlot = 2)
        assertEquals(2, after[1].physicalSlot)
    }

    @Test fun mapToPhysicalBumpClearsAllCollidingRows() {
        // Defensive: if the prior state already had two rows colliding
        // (e.g. via a corrupt DataStore), a fresh assignment to that
        // physical extruder should leave exactly one row mapped to it.
        val before = baseList().mapIndexed { i, f ->
            when (i) {
                0, 1 -> f.copy(physicalSlot = 0)
                else -> f
            }
        }
        val after = applyMapToPhysical(before, slot = 2, physicalSlot = 0)
        assertNull(after[0].physicalSlot)
        assertNull(after[1].physicalSlot)
        assertEquals(0, after[2].physicalSlot)
    }

    @Test fun mapToVirtualSetsVirtualAndClearsPhysical() {
        val before = baseList().mapIndexed { i, f ->
            if (i == 1) f.copy(physicalSlot = 3) else f
        }
        val after = applyMapToVirtual(before, slot = 1, virtualSlot = 2)
        assertEquals(2, after[1].virtualSlot)
        assertNull(after[1].physicalSlot)
    }

    @Test fun mapToVirtualOnSlot1DoesNotTouchSlot0Remap() {
        val before = baseList().mapIndexed { i, f ->
            if (i == 0) f.copy(physicalSlot = 2) else f
        }
        val after = applyMapToVirtual(before, slot = 1, virtualSlot = 1)
        assertEquals(2, after[0].physicalSlot)
        assertEquals(1, after[1].virtualSlot)
    }

    @Test fun clearMappingResetsBothFieldsButOnlyOnTarget() {
        val before = listOf(
            baseList()[0].copy(physicalSlot = 1),
            baseList()[1].copy(virtualSlot = 1),
            baseList()[2].copy(physicalSlot = 3),
            baseList()[3].copy(virtualSlot = 2),
        )
        val after = applyClearMapping(before, slot = 1)
        assertEquals(1, after[0].physicalSlot)
        assertNull(after[1].physicalSlot)
        assertNull(after[1].virtualSlot)
        assertEquals(3, after[2].physicalSlot)
        assertEquals(2, after[3].virtualSlot)
    }

    @Test fun changeTypeOnSlot3DoesNotPropagate() {
        val before = baseList()
        val after = applyChangeType(before, slot = 3, type = "PA-CF")
        assertEquals("PLA", after[0].filamentType)
        assertEquals("PLA", after[1].filamentType)
        assertEquals("PLA", after[2].filamentType)
        assertEquals("PA-CF", after[3].filamentType)
        // Color and slot index unchanged on the edited row.
        assertEquals(before[3].color, after[3].color)
        assertEquals(3, after[3].slotIndex)
    }

    @Test fun changeTypePreservesMappingTarget() {
        // Material edits are a separate axis from mapping; a row with
        // physicalSlot=2 and type=PLA → type=PETG keeps printing from T2.
        val before = baseList().mapIndexed { i, f ->
            if (i == 1) f.copy(physicalSlot = 0) else f
        }
        val after = applyChangeType(before, slot = 1, type = "PETG")
        assertEquals("PETG", after[1].filamentType)
        assertEquals(0, after[1].physicalSlot)
    }

    @Test fun outOfRangeSlotIsNoOpForEveryHelper() {
        val before = baseList()
        assertEquals(before, applyChangeColor(before, slot = 99, hex = "#000000"))
        assertEquals(before, applyMapToPhysical(before, slot = -1, physicalSlot = 0))
        assertEquals(before, applyMapToVirtual(before, slot = 99, virtualSlot = 1))
        assertEquals(before, applyClearMapping(before, slot = -1))
        assertEquals(before, applyChangeType(before, slot = 99, type = "PETG"))
    }
}
