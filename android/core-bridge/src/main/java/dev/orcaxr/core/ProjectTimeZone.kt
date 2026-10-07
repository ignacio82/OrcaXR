package dev.orcaxr.core

import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset

/** Capture the zone for one project owner, including any pending import.
 * Rust parses/normalizes V8 date syntax; java.time supplies timezone rules.
 * atZone moves gaps forward and chooses the earlier instant during overlap. */
class ProjectTimeZone(private val zone: ZoneId) : LocalTimestampResolver {
    override fun resolve(civilMilliseconds: Long): Long =
        LocalDateTime.ofInstant(Instant.ofEpochMilli(civilMilliseconds), ZoneOffset.UTC)
            .atZone(zone).toInstant().toEpochMilli()
}
