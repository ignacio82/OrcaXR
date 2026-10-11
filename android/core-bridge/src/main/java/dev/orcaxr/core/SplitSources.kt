package dev.orcaxr.core

/** Which split reads a source: separate objects, or parts of the same object. */
enum class SplitTarget(val wire: String) { OBJECTS("objects"), PARTS("parts") }

/** How an object splits: its existing volumes promoted, or its one volume separated by connected body. */
enum class SplitStrategy(val wire: String) { EXISTING_VOLUMES("existing-volumes"), CONNECTED_COMPONENTS("connected-components") }

/**
 * The object a split replaces, as the browser's confirmation describes it
 * (`SplitSource.ts`): where it is, its name, how it splits, its volumes and
 * their triangles, and every placement the split replaces, in its order.
 */
data class SplitSource(
    val plateId: String,
    val objectId: String,
    val objectName: String,
    val strategy: SplitStrategy,
    val volumeIds: List<String>,
    val triangleCount: Long,
    val instanceIds: List<String>,
)

/** What a captured project answers for a split: its source, or the workspace's refusal in its words. */
sealed interface SplitSourceResult {
    data class Found(val source: SplitSource) : SplitSourceResult
    data class Refused(val message: String) : SplitSourceResult
}

/**
 * What a split of the selected instance would split, in the shared core
 * (`orcaxr_project::split::source`, the browser's `SplitSourceExchange.ts`);
 * a captured project answers through [ProjectSnapshot.splitSource].
 */
object SplitSources {
    /**
     * The workspace's synchronous connected-component limit
     * (`CANONICAL_SPLIT_TO_OBJECTS_SYNC_TRIANGLE_CAP`): a single volume of more
     * triangles is not split.
     */
    const val SYNC_TRIANGLE_LIMIT = 50_000L

    /** `{"instanceId","target","triangleLimit"}`, as the exchange reads it. */
    fun request(instanceId: String, target: SplitTarget, triangleLimit: Long = SYNC_TRIANGLE_LIMIT): String {
        require(triangleLimit in 1..9_007_199_254_740_991L) { "invalid_request" }
        return "{\"instanceId\":${CanonicalJson.quote(instanceId)},\"target\":\"${target.wire}\",\"triangleLimit\":$triangleLimit}"
    }

    /** The exchange's reply: `{"source": {...}}` or `{"refusal": message}`. */
    fun read(json: String): SplitSourceResult {
        val reply = CanonicalJson.read(json) as ProjectJsonObject
        if (reply.keys().next() == "refusal") return SplitSourceResult.Refused(reply.get("refusal") as String)
        val source = reply.get("source") as ProjectJsonObject
        fun strings(name: String) = (source.get(name) as ProjectJsonArray).let { list -> List(list.length()) { list.get(it) as String } }
        val strategy = source.get("strategy") as String
        return SplitSourceResult.Found(
            SplitSource(
                source.get("plateId") as String,
                source.get("objectId") as String,
                source.get("objectName") as String,
                SplitStrategy.entries.first { it.wire == strategy },
                strings("volumeIds"),
                (source.get("triangleCount") as Double).toLong(),
                strings("instanceIds"),
            ),
        )
    }
}
