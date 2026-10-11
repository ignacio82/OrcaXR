package dev.orcaxr.nativeapp.shell

/**
 * How the bottom bar's areas share its width, so no name is cut short — the
 * browser's tab strip keeps every tab's whole name too. Given each item's
 * natural width (its name on one line, with its padding) and the bar's, the
 * items go in order on as few rows as fit, their counts as even as rows allow
 * (the earlier rows the fuller on a tie); in a row every item gets an equal
 * share when all fit one, else its natural width and an equal part of what is
 * left. A phone at the usual text size keeps one row of equal items, as
 * Material's bar; enlarged text or a language with longer words takes a
 * second row instead of an ellipsis. An item wider than the bar on its own
 * row is given the whole width, where its name wraps.
 */
object NavigationRows {
    /** The widths of the items row by row, for items of [natural] widths in a bar [available] wide. */
    fun arrange(natural: List<Int>, available: Int): List<List<Int>> {
        require(available > 0 && natural.all { it >= 0 })
        if (natural.isEmpty()) return emptyList()
        for (rows in 1..natural.size) {
            val counts = compositions(natural.size, rows)
                .filter { counts -> runs(natural, counts).all { it.sum() <= available } }
                .minWithOrNull(compareBy<List<Int>> { it.max() - it.min() }.then { a, b -> compareCounts(b, a) })
                ?: continue
            return runs(natural, counts).map { share(it, available) }
        }
        return natural.map { listOf(available) }
    }

    /** Every way of cutting [items] items into [rows] non-empty runs, as the runs' lengths. */
    private fun compositions(items: Int, rows: Int): List<List<Int>> =
        if (rows == 1) listOf(listOf(items))
        else (1..items - rows + 1).flatMap { first -> compositions(items - first, rows - 1).map { listOf(first) + it } }

    /** Lexicographic order of run lengths: the earlier runs longer sort later. */
    private fun compareCounts(a: List<Int>, b: List<Int>): Int {
        for (index in a.indices) if (a[index] != b[index]) return a[index].compareTo(b[index])
        return 0
    }

    private fun runs(items: List<Int>, counts: List<Int>): List<List<Int>> {
        var at = 0
        return counts.map { count -> items.subList(at, at + count).also { at += count } }
    }

    /** One row's widths in [available]: equal shares when every item fits one, else natural plus an equal part of the rest. */
    private fun share(row: List<Int>, available: Int): List<Int> {
        val equal = available / row.size
        return spread(if (row.all { it <= equal }) List(row.size) { 0 } else row, available)
    }

    /** [widths] grown by an equal part of what [available] leaves, the remainder to the first items, so they fill it exactly. */
    private fun spread(widths: List<Int>, available: Int): List<Int> {
        val left = available - widths.sum()
        val part = left / widths.size
        val extra = left % widths.size
        return widths.mapIndexed { index, width -> width + part + if (index < extra) 1 else 0 }
    }
}
