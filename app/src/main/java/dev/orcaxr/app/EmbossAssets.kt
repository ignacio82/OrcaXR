package dev.orcaxr.app

import android.content.Context
import java.io.File

/**
 * D4 — bundled font registry + on-demand asset staging.
 *
 * The native side reads fonts via `Emboss::create_font_file(const
 * char*)` which only takes a real filesystem path. APK assets aren't
 * filesystem paths (they live inside the .apk), so the first time the
 * user picks one of the bundled fonts we copy it into `cacheDir` and
 * return a [File] handle the JNI can `fopen`.
 *
 * Bundled fonts:
 * - **DejaVu Sans Bold** — wide-coverage Latin/Greek/Cyrillic sans,
 *   default for the Emboss panel. Public domain / Bitstream Vera
 *   license (free redistribution).
 * - **DejaVu Serif** — companion serif face. Same license.
 *
 * To add a new bundled font, drop the .ttf in `assets/fonts/` and add
 * a [BundledFont] entry below. The native side uses stb_truetype, so
 * any .ttf or .otf with a standard `glyf`/`CFF ` table works.
 *
 * Users can also pick their own .ttf from device storage via SAF; in
 * that case the caller is responsible for staging the picked file
 * (e.g. `ContentResolver.openInputStream(uri).copyTo(File(cacheDir,
 * "user_font.ttf"))`) and passing the resulting `File` straight to
 * `SlicerEngine.buildTextMesh`.
 */
data class BundledFont(
    /** Stable identifier used to key the staged copy on disk. */
    val id: String,
    /** Human-readable label shown in the font picker. */
    val displayName: String,
    /** Path inside `app/src/main/assets/`. */
    val assetPath: String,
)

object EmbossAssets {
    /** Default font: DejaVu Sans Bold. Used when no font is explicitly
     *  picked. Order matters — the picker shows fonts in this order. */
    val BUNDLED_FONTS: List<BundledFont> = listOf(
        BundledFont(
            id = "dejavu_sans_bold",
            displayName = "DejaVu Sans Bold",
            assetPath = "fonts/DejaVuSans-Bold.ttf",
        ),
        BundledFont(
            id = "dejavu_serif",
            displayName = "DejaVu Serif",
            assetPath = "fonts/DejaVuSerif.ttf",
        ),
    )

    /** Convenience: the first bundled font, used as the picker default. */
    val DEFAULT_FONT: BundledFont = BUNDLED_FONTS.first()

    /**
     * Copy [font] from `assets/` into a stable file under
     * `[ctx].cacheDir/fonts/`. The destination path is keyed on the
     * font's [BundledFont.id] so subsequent calls just return the
     * already-staged file (idempotent).
     *
     * Throws on I/O failure (typically: out-of-disk on cacheDir).
     */
    fun stageBundledFont(ctx: Context, font: BundledFont): File {
        val dir = File(ctx.cacheDir, "fonts").apply { mkdirs() }
        val dst = File(dir, "${font.id}.ttf")
        if (dst.exists() && dst.length() > 0L) return dst
        ctx.assets.open(font.assetPath).use { input ->
            dst.outputStream().use { output -> input.copyTo(output) }
        }
        return dst
    }

    /**
     * Copy the bundled SVG fixture (`assets/svg/heart.svg`) to
     * `cacheDir/svg/heart.svg`. Used by tests and as a quick-start
     * "try a sample SVG" button in the emboss panel. Idempotent.
     */
    fun stageBundledSampleSvg(ctx: Context): File {
        val dir = File(ctx.cacheDir, "svg").apply { mkdirs() }
        val dst = File(dir, "heart.svg")
        if (dst.exists() && dst.length() > 0L) return dst
        ctx.assets.open("svg/heart.svg").use { input ->
            dst.outputStream().use { output -> input.copyTo(output) }
        }
        return dst
    }
}
