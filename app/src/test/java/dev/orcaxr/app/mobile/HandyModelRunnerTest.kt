package dev.orcaxr.app.mobile

import org.junit.Assert.assertTrue
import org.junit.Test

/** Hermetic test of the catalog the phone picker lists. The `add()`
 *  path is a thin ToolDispatch wrapper (covered by ToolDispatchTest +
 *  HandyModelTools' own coverage) and needs a Context, so it isn't
 *  exercised here. */
class HandyModelRunnerTest {

    @Test fun entriesAreNonEmptyAndWellFormed() {
        val e = HandyModelRunner.entries()
        assertTrue("catalog non-empty", e.isNotEmpty())
        for (m in e) {
            assertTrue("id", m.id.isNotBlank())
            assertTrue("displayName", m.displayName.isNotBlank())
            assertTrue("fileName derived", m.fileName.isNotBlank())
        }
        // ids must be unique (the picker keys on them).
        assertTrue("unique ids", e.map { it.id }.toSet().size == e.size)
    }
}
