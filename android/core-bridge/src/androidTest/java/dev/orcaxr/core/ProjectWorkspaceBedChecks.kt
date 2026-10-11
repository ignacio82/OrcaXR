package dev.orcaxr.core

/** The workspace bed through the Kotlin wrapper (`workspace-bed-vectors.json`):
 * every configuration's bed reads as the browser's reply reads, malformed
 * requests are refused, [WorkspaceBeds.of] composes its request, and each
 * recorded project, opened as a real session, answers for each of its plates
 * through [ProjectSnapshot.workspaceBed]. */
object ProjectWorkspaceBedChecks {
    private fun failure(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

    /** [script] lines: `B <request> <reply>`, `R <request>`, `P <stateJson>`, then
     * `Q <plateId JSON> <reply>` for that project's plates (tab-separated). */
    @JvmStatic fun run(script: String): Long {
        var checks = 0L
        fun check(condition: Boolean, label: String) {
            kotlin.check(condition) { label }
            checks++
        }
        var project: ProjectSession? = null
        ProjectPreparation().use { scope ->
            for (line in script.split("\n")) {
                val entry = line.split("\t")
                when (entry[0]) {
                    "B" -> {
                        check(NativeProject.workspaceBed(entry[1]) == entry[2], "bed_reply_$checks")
                        check(WorkspaceBeds.read(NativeProject.workspaceBed(entry[1])) == WorkspaceBeds.read(entry[2]), "bed_typed_$checks")
                    }
                    "R" -> check(failure { NativeProject.workspaceBed(entry[1]) } == "invalid_request", "bed_refused_$checks")
                    "P" -> {
                        project?.dispose()
                        val bytes = entry[1].toByteArray(Charsets.UTF_8)
                        val upload = scope.own(ProjectUpload(bytes.size.toLong(), ProjectHostOptions(bytes.size.toLong(), 1_000_000, 8_000_000, 1024, 128, 0, 16_777_216, 33_554_432, 100, 33_554_432), LocalTimestampResolver { it }, ProjectIntegerProfile.NODE))
                        for (start in bytes.indices step ProjectHost.MAX_CHUNK_BYTES) upload.appendDocument(start.toLong(), bytes.copyOfRange(start, minOf(start + ProjectHost.MAX_CHUNK_BYTES, bytes.size)))
                        upload.sealDocument()
                        project = scope.own(upload.open())
                    }
                    "Q" -> {
                        val plate = (CanonicalJson.read(entry[1]) as ProjectJsonObject).get("plateId") as? String
                        val bed = checkNotNull(project).snapshot().use { it.workspaceBed(plate) }
                        check(bed == WorkspaceBeds.read(entry[2]), "project_bed_$checks $bed")
                    }
                    else -> error("unknown line ${entry[0]}")
                }
            }
            project?.dispose()
        }
        // The request [WorkspaceBeds.of] writes, and what its parts mean.
        check(WorkspaceBeds.of("{}") == WorkspaceBed.DEFAULT, "of_default")
        val u1 = WorkspaceBeds.of(
            "{\"printable_area\":[\"0.5x1\",\"270.5x1\",\"270.5x271\",\"0.5x271\"],\"printable_height\":\"250\",\"prime_tower_width\":\"35\"}",
            "{\"enabled\":true,\"positionMm\":[200,210],\"rotationDeg\":0}",
        )
        val u1Area = PrintableArea(0.5, 1.0, 270.5, 271.0)
        check(
            u1 == WorkspaceBed(
                270.5, 271.0, u1Area, 250.0, KeepOut(200.0, 210.0, 235.0, 245.0),
                u1Area, BuildVolume(listOf(0.5, 1.0, 0.0), listOf(270.5, 271.0, 250.0)),
            ),
            "of_u1 $u1",
        )
        // An area far from the bed corner: placements use it, never the far corner's half.
        val far = WorkspaceBeds.of("{\"printable_area\":\"180x150,300x150,300x260,180x260\",\"printable_height\":\"100\"}")
        check(
            far.areaMm == PrintableArea(180.0, 150.0, 300.0, 260.0) && far.widthMm == 300.0 &&
                far.volumeMm == BuildVolume(listOf(180.0, 150.0, 0.0), listOf(300.0, 260.0, 100.0)),
            "of_far $far",
        )
        val infinite = WorkspaceBeds.of("{\"prime_tower_width\":\"Infinity\"}", "{\"enabled\":true,\"positionMm\":[1,2],\"rotationDeg\":0}").keepOut
        check(infinite != null && infinite.minX == 1.0 && infinite.maxX.isNaN() && infinite.maxY.isNaN(), "of_infinite_edge $infinite")
        check(failure { WorkspaceBeds.of("[]") } == "invalid_request", "of_refused")
        return checks
    }
}
