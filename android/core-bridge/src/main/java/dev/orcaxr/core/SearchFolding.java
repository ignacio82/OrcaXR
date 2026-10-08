package dev.orcaxr.core;

/** Folds settings search text as the browser does with
 * {@code text.normalize("NFKD").toLocaleLowerCase("en-US")}. Called on the
 * thread running the query; a thrown exception refuses the query. */
public interface SearchFolding {
    char[] fold(char[] text);

    /** The platform's NFKD normalization and US-English lowercasing. */
    SearchFolding PLATFORM = text ->
        java.text.Normalizer.normalize(new String(text), java.text.Normalizer.Form.NFKD)
            .toLowerCase(java.util.Locale.US)
            .toCharArray();
}
