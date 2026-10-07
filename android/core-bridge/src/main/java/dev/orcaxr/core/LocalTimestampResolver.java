package dev.orcaxr.core;

/** Convert a normalized local civil time to UTC. Failure must throw; UTC is
 * never a fallback. Implementations must not reenter their native session. */
public interface LocalTimestampResolver {
    long resolve(long civilMilliseconds);
}
