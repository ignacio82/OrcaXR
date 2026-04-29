package dev.orcaxr.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Roadmap B7 — verify [RecentFilesCodec] round-trips the recents list,
 * de-dupes by path on upsert, caps at [RecentFilesStore.MAX_ENTRIES],
 * and tolerates malformed JSON gracefully.
 */
class RecentFilesCodecTest {

    @Test fun encode_decode_round_trip_preserves_order() {
        val list = listOf(
            RecentFile("/sd/a.stl", "a.stl", 1_000),
            RecentFile("/sd/b.3mf", "b.3mf", 2_000),
            RecentFile("/sd/c.stl", "c.stl", 3_000),
        )
        val decoded = RecentFilesCodec.decode(RecentFilesCodec.encode(list))
        assertEquals(list, decoded)
    }

    @Test fun decode_garbage_returns_empty() {
        // Malformed JSON shouldn't throw — the recents row should
        // just disappear instead of taking down the empty-state panel.
        assertEquals(emptyList<RecentFile>(), RecentFilesCodec.decode("{not even an array"))
        assertEquals(emptyList<RecentFile>(), RecentFilesCodec.decode(""))
    }

    @Test fun decode_skips_entries_with_blank_path() {
        // A persisted entry whose path got cleared (older format,
        // user wiped storage) shouldn't be surfaced — drop it
        // silently rather than render an unreachable button.
        val raw = """[{"path":"","label":"x","openedAtMs":1},{"path":"/sd/x.stl","label":"x","openedAtMs":2}]"""
        val decoded = RecentFilesCodec.decode(raw)
        assertEquals(1, decoded.size)
        assertEquals("/sd/x.stl", decoded[0].path)
    }

    @Test fun upsert_inserts_new_at_head() {
        val before = listOf(
            RecentFile("/sd/a.stl", "a.stl", 1_000),
            RecentFile("/sd/b.stl", "b.stl", 2_000),
        )
        val after = RecentFilesCodec.upsert(before, RecentFile("/sd/c.stl", "c.stl", 3_000))
        assertEquals(3, after.size)
        assertEquals("/sd/c.stl", after[0].path)
        assertEquals("/sd/a.stl", after[1].path)
        assertEquals("/sd/b.stl", after[2].path)
    }

    @Test fun upsert_de_dupes_by_path_bumping_to_head() {
        // Re-opening an existing file bumps it to the top instead of
        // double-listing. The bumped entry's openedAtMs is the new
        // timestamp.
        val before = listOf(
            RecentFile("/sd/a.stl", "a.stl", 1_000),
            RecentFile("/sd/b.stl", "b.stl", 2_000),
            RecentFile("/sd/c.stl", "c.stl", 3_000),
        )
        val after = RecentFilesCodec.upsert(before, RecentFile("/sd/b.stl", "b.stl", 4_000))
        assertEquals(3, after.size)
        assertEquals("/sd/b.stl", after[0].path)
        assertEquals(4_000L, after[0].openedAtMs)
        assertEquals("/sd/a.stl", after[1].path)
        assertEquals("/sd/c.stl", after[2].path)
    }

    @Test fun upsert_caps_at_max_entries() {
        // Filling past the cap drops the OLDEST (last-position) entry.
        val before = (0 until RecentFilesStore.MAX_ENTRIES).map { i ->
            RecentFile("/sd/$i.stl", "$i.stl", i.toLong())
        }
        val after = RecentFilesCodec.upsert(
            before,
            RecentFile("/sd/new.stl", "new.stl", 9_999L),
        )
        assertEquals(RecentFilesStore.MAX_ENTRIES, after.size)
        // New head is the upserted entry; the previous oldest dropped.
        assertEquals("/sd/new.stl", after[0].path)
        // The dropped one was the highest index in `before`, since it
        // sat at the tail.
        val droppedPath = "/sd/${RecentFilesStore.MAX_ENTRIES - 1}.stl"
        assertTrue("expected $droppedPath dropped, got $after", after.none { it.path == droppedPath })
    }

    @Test fun upsert_on_empty_returns_singleton() {
        val after = RecentFilesCodec.upsert(emptyList(), RecentFile("/sd/x.stl", "x.stl", 1L))
        assertEquals(1, after.size)
        assertEquals("/sd/x.stl", after[0].path)
    }

    @Test fun encode_emits_compact_json_array() {
        // Lock the format so a future change can't silently switch to
        // an object-shape that the decoder doesn't understand.
        val one = listOf(RecentFile("/sd/a.stl", "a.stl", 1_000))
        val json = RecentFilesCodec.encode(one)
        assertTrue("expected JSON array, got $json", json.startsWith("[") && json.endsWith("]"))
        assertTrue(json.contains(""""path":"\/sd\/a.stl"""") || json.contains(""""path":"/sd/a.stl""""))
        assertTrue(json.contains(""""openedAtMs":1000"""))
    }
}
