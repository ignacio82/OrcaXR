package dev.orcaxr.nativeapp

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * The localized resources `tools/cross-platform/android-strings.mjs` writes
 * from the browser's catalogues (values-qualifier/strings.xml) take exactly
 * the format arguments of their English, so `getString(id, …)` can never read
 * past, skip or retype an argument in one language only — a translation that
 * lost `%1$s` would show a sentence with a hole where the file name was.
 */
class LocalizedResourcesTest {
    private val res = File("src/main/res")

    /** A resource's texts by quantity ("" for a string), and whether Android formats it. */
    private class Resource(val plural: Boolean, val texts: Map<String, String>, val formatted: Boolean)

    private fun read(file: File): Map<String, Resource> {
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val out = LinkedHashMap<String, Resource>()
        val children = document.documentElement.childNodes
        for (index in 0 until children.length) {
            val element = children.item(index) as? Element ?: continue
            val name = element.getAttribute("name")
            when (element.tagName) {
                "string" -> out[name] = Resource(false, mapOf("" to element.textContent), element.getAttribute("formatted") != "false")
                "plurals" -> {
                    val items = element.getElementsByTagName("item")
                    out[name] = Resource(
                        true,
                        (0 until items.length).associate { (items.item(it) as Element).let { item -> item.getAttribute("quantity") to item.textContent } },
                        true,
                    )
                }
            }
        }
        return out
    }

    /** The format specifiers of [text], in order of position, `%%` aside. */
    private fun arguments(text: String): List<String> =
        SPECIFIER.findAll(text).map { it.value }.filter { it != "%%" }.toList().sorted()

    private fun localized(): List<File> =
        res.listFiles { file -> file.isDirectory && file.name.startsWith("values-") }.orEmpty()
            .map { File(it, "strings.xml") }.filter { it.isFile }.sortedBy { it.path }

    @Test
    fun everyLocalizedResourceTakesItsEnglishArguments() {
        assertTrue("run from the app module", res.isDirectory)
        val english = read(File(res, "values/strings.xml"))
        val files = localized()
        assertTrue("the generator wrote no languages", files.isNotEmpty())
        var checked = 0
        for (file in files) {
            for ((name, resource) in read(file)) {
                val where = "${file.parentFile.name}/$name"
                val source = english[name]
                assertNotNull("$where has no English", source)
                source!!
                assertEquals("$where is a ${if (source.plural) "plural" else "string"} in English", source.plural, resource.plural)
                if (!resource.plural) {
                    // formatted="false" marks a text whose `%` is literal: it takes no arguments.
                    val expected = if (source.formatted) arguments(source.texts.getValue("")) else emptyList()
                    assertEquals(where, expected, if (resource.formatted) arguments(resource.texts.getValue("")) else emptyList())
                } else {
                    // A form may leave out the number ICU's `#` stands for, never add an argument;
                    // together the forms take every argument the English takes.
                    val all = source.texts.values.flatMap(::arguments).toSortedSet()
                    for ((quantity, text) in resource.texts) {
                        assertTrue("$where/$quantity is no CLDR category", quantity in QUANTITIES)
                        assertTrue("$where/$quantity takes ${arguments(text)}, not within $all", all.containsAll(arguments(text)))
                    }
                    assertEquals(where, all, resource.texts.values.flatMap(::arguments).toSortedSet())
                    assertTrue("$where has no other form", "other" in resource.texts)
                }
                checked++
            }
        }
        assertTrue(checked > 0)
    }

    @Test
    fun theOfferedLanguagesAreTheGeneratedOnes() {
        // Each language with words of its own, and English, is offered for the app's own language setting.
        val config = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File(res, "xml/locales_config.xml"))
        val locales = config.getElementsByTagName("locale")
        val offered = (0 until locales.length).map { (locales.item(it) as Element).getAttribute("android:name") }.toSet()
        val qualified = localized().map { file ->
            val qualifier = file.parentFile.name.removePrefix("values-")
            when {
                qualifier.startsWith("b+") -> qualifier.removePrefix("b+").replace('+', '-')
                "-r" in qualifier -> qualifier.replace("-r", "-")
                else -> qualifier
            }
        }.toSet()
        assertEquals(qualified + "en", offered)
    }

    private companion object {
        val SPECIFIER = Regex("%(?:\\d+\\$)?[-#+ 0,(<]*\\d*(?:\\.\\d+)?[tT]?[a-zA-Z%]")
        val QUANTITIES = setOf("zero", "one", "two", "few", "many", "other")
    }
}
