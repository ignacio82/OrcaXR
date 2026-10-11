package dev.orcaxr.nativeapp.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class NavigationRowsTest {
    @Test fun namesThatFitShareTheBarEqually() {
        // Five areas on a 480 px bar: one row of 96 px each, as Material's bar.
        assertEquals(listOf(List(5) { 96 }), NavigationRows.arrange(listOf(70, 50, 52, 44, 47), 480))
        // The remainder goes to the first items, so the row fills the bar exactly.
        assertEquals(listOf(listOf(55, 55, 55, 55, 54)), NavigationRows.arrange(listOf(50, 40, 40, 40, 40), 274))
    }

    @Test fun aNameWiderThanAnEqualShareKeepsItsWidth() {
        // "Workspace" needs 64 of a 274 px bar's 54.8: it gets its width, the rest share what is left.
        val row = NavigationRows.arrange(listOf(64, 46, 46, 44, 44), 274).single()
        assertEquals(274, row.sum())
        assertEquals(listOf(70, 52, 52, 50, 50), row)
    }

    @Test fun enlargedNamesTakeASecondRowInsteadOfBeingCut() {
        // At larger text five names need 400 px of a 274 px bar: two rows, the first the fuller.
        val rows = NavigationRows.arrange(listOf(100, 80, 80, 70, 70), 274)
        assertEquals(listOf(3, 2), rows.map { it.size })
        rows.forEach { assertEquals(274, it.sum()) }
        // When three wide names do not fit together, two rows cut where they fit: two, then three.
        assertEquals(listOf(2, 3), NavigationRows.arrange(listOf(124, 88, 90, 76, 80), 274).map { it.size })
        // Wider still: three rows, as even as they fit.
        assertEquals(listOf(2, 2, 1), NavigationRows.arrange(listOf(124, 120, 110, 100, 90), 274).map { it.size })
    }

    @Test fun aNameWiderThanTheBarHasARowToItself() {
        assertEquals(listOf(listOf(200), listOf(200)), NavigationRows.arrange(listOf(150, 260), 200))
        assertEquals(emptyList<List<Int>>(), NavigationRows.arrange(emptyList(), 200))
    }
}
