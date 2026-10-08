package dev.orcaxr.core;

/** Orders preset text the way the browser's {@code localeCompare(…, 'en')}
 * does. Android hosts pass an ICU English collator; without one the core uses
 * its exact ASCII root order and refuses a catalog with any other text. Called
 * on the building thread; it must not call back into the core. Arrays are
 * complete UTF-16, including any lone surrogate. */
public interface PresetCollator {
    int compare(char[] left, char[] right);
}
