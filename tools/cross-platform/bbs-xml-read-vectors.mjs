// Execute the production model XML validator unchanged; capture its tag parser.
// AST extraction avoids exporting a private browser helper solely for tests.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { assertXmlValue } from "../../web/src/project/serialization/bbsXml.ts";
const root = new URL("../../", import.meta.url),
  read = (p) => readFileSync(new URL(p, root));
const require = createRequire(new URL("web/package.json", root)),
  ts = require("typescript");
const sourcePath = "web/src/project/serialization/bbsCore.ts",
  source = read(sourcePath).toString();
const names = new Set([
  "validatedXmlMarkup",
  "findXmlTagEnd",
  "parseXmlOpeningTag",
  "validateXmlText",
  "validateXmlEntities",
  "isXmlCodePoint",
  "assertXmlName",
  "assertBoundXmlName",
  "assertXmlNamespaceBinding",
  "decodeXml",
]);
const ast = ts.createSourceFile(
  sourcePath,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const functions = ast.statements.filter(
  (s) => ts.isFunctionDeclaration(s) && names.has(s.name?.text),
);
assert.equal(functions.length, names.size);
const compiled = ts.transpileModule(
  functions.map((f) => f.getText(ast)).join("\n"),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  },
).outputText;
const oracle = new Function(
  "assertXmlValue",
  compiled +
    `\nreturn (xml) => {
 const tags=[]; const original=parseXmlOpeningTag;
 parseXmlOpeningTag=(source,path)=>{ const tag=original(source,path); tags.push(tag); return tag; };
 try { return {sanitized:validatedXmlMarkup(xml,'model'),openings:tags}; }
 finally { parseXmlOpeningTag=original; }
};`,
)(assertXmlValue);
const enc = new TextEncoder(),
  cases = [];
function add(name, input) {
  const bytes =
    typeof input === "string" ? enc.encode(input) : Uint8Array.from(input);
  let expected = null;
  try {
    expected = oracle(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    /* The production validator refused these exact bytes. */
  }
  cases.push({ name, bytesHex: Buffer.from(bytes).toString("hex"), expected });
}
for (const [name, xml] of Object.entries({
  empty: "",
  single: "<model/>",
  paired: "<model></model>",
  spaces: " \t\r\n<model/> \n",
  bom: "\ufeff<model/>",
  doubleBom: "\ufeff\ufeff<model/>",
  text: "<model>snow 雪 🐳 &amp; &#x1F433;</model>",
  multiRoot: "<a/><b/>",
  outsideText: "x<a/>",
  tailText: "<a/>x",
  emptyClosing: "<a></>",
  mismatch: "<a></b>",
  caseMismatch: "<a></A>",
  bareClose: "</a>",
  unfinished: "<a>",
  quoteDelimiter: '<a x="<"/>',
  quoteGreater: '<a x=">"/>',
  unquoted: "<a x=a/>",
  missingValue: "<a x/>",
  duplicate: '<a x="1" x="2"/>',
  adjacent: '<a x="1"y="2"/>',
  spacedStart: "< model / >",
  spacedClose: "<a></ a >",
  closingAttr: '<a></a x="1">',
  attributeNoSpace: '<a/x="1">',
  afterSlash: '<a/ x="1">',
  unfinishedTag: '<a x="',
  comment: "<!-- before --><a><!-- 🌍 &unknown; --></a><!-- after -->",
  badComment: "<a><!-- a--b --></a>",
  unfinishedComment: "<a><!-- x",
  cdata: '<a><![CDATA[<fake x="x"/> &unknown; 雪 🐳]]></a>',
  outsideCdata: "<![CDATA[x]]><a/>",
  unfinishedCdata: "<a><![CDATA[x",
  tailCdata: "<a>]]></a>",
  pi: "<?anything <fake/> 雪?><a><?x?></a><?tail?>",
  unfinishedPi: "<?x <a/>",
  declaration: "<!foo><a/>",
  doctype: "<!DOCTYPE a><a/>",
  entity: '<!ENTITY a "x"><a/>',
  hiddenDtd: "<a><!-- <!DoCtYpE a> --></a>",
  hiddenEntity: "<a><![CDATA[<!ENTITY a>]]></a>",
  hiddenPiDtd: "<?x <!doctype a>?><a/>",
  doctypeWord: "<a><!-- <!DOCTYPE_x> <!ENTITY1> --></a>",
  doctypeBoundary: "<a><!-- <!DOCTYPEé> --></a>",
  namespace: '<p:model xmlns:p="urn:p"><p:child p:x="1"/></p:model>',
  implicitXml: '<a xml:lang="x"/>',
  undeclared: "<p:model/>",
  undeclaredAttribute: '<a p:x="1"/>',
  emptyPrefix: '<a xmlns:p=""/>',
  emptyDefault: '<a xmlns=""/>',
  scope: '<a xmlns:p="urn:parent"><b xmlns:p="urn:child"><p:c/></b><p:d/></a>',
  closedScope: '<a><b xmlns:p="urn:b"/><p:c/></a>',
  sameTagBinding: '<p:a p:x="1" xmlns:p="urn:p"/>',
  overwriteXml: '<a xmlns:xml="private" xml:x="1"/>',
  namespaceNamed: '<a xmlns:xmlns="urn:x"/>',
  prefixAliases: '<a xmlns:p="urn:x" xmlns:q="urn:x" p:x="1" q:x="2"/>',
  reservedXmlPrefix: '<a xmlns:xmlns="urn:x"/>',
  wrongXmlUri: '<a xmlns:xml="urn:x"/>',
  xmlUriAlias: '<a xmlns:p="http://www.w3.org/XML/1998/namespace"/>',
  xmlUriDefault: '<a xmlns="http://www.w3.org/XML/1998/namespace"/>',
  xmlnsUriAlias: '<a xmlns:p="http://www.w3.org/2000/xmlns/"/>',
  xmlNameCorrect:
    '<xml:a xmlns:xml="http://www.w3.org/XML/1998/namespace" xml:lang="en"/>',
  prototype: '<a __proto__="1" constructor="2" prototype="3"/>',
  escaped: '<a x="&amp;&lt;&gt;&quot;&apos;&#0009;&#x1f433;"/>',
  uppercaseEntities: '<a x="&AMP;&Lt;&gT;&QuOt;&APOS;&#X41;"/>',
  nestedEntities: '<a x="&amp;lt;"/>',
  unknownEntity: "<a>&nbsp;</a>",
  incompleteEntity: "<a>&amp</a>",
  doubleAmp: "<a>&&amp;</a>",
  rawQuote: "<a>\"'</a>",
}))
  add(name, xml);
for (const name of [
  "a",
  "A",
  "_a",
  "a.b",
  "a-b",
  "a:b",
  "a:b:c",
  "1a",
  "a!",
  "é",
  "🐳",
  ":a",
  "a:",
  "a__",
  "xmlns",
  "xml:a",
]) {
  add(`element-name-${name}`, `<${name}/>`);
  add(`attribute-name-${name}`, `<a ${name}="1"/>`);
}
for (const cp of [
  0, 1, 8, 9, 10, 11, 12, 13, 31, 32, 0x85, 0xa0, 0x1680, 0x180e, 0x2000,
  0x200b, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xd7ff, 0xe000, 0xfffd,
  0xfffe, 0xffff, 0x10000, 0x10ffff,
]) {
  const value = String.fromCodePoint(cp);
  add(`text-character-${cp}`, `<a>${value}</a>`);
  add(`ignored-character-${cp}`, `<a><!-- ${value} --></a>`);
  add(`whitespace-character-${cp}`, `<a${value}x="1"/>`);
  add(`outside-character-${cp}`, `${value}<a/>${value}`);
  add(`entity-decimal-${cp}`, `<a x="&#${cp};"/>`);
  add(`entity-hex-${cp}`, `<a>&#x${cp.toString(16)};</a>`);
}
for (const body of [
  "#-1",
  "#+9",
  "#1.0",
  "#1e2",
  "#x",
  "#X110000",
  "#55296",
  "#57343",
  "#1114112",
  "#999999999999999999999999999999",
  "#xD800",
  "#xFFFFFFFFFFFFFFFF",
  "#00000000000000000000000000000000065",
  "AMP",
  "unknown",
  "amp;lt",
])
  add(`entity-${body}`, `<a x="&${body};"/>`);
for (const bytes of [
  [0x80],
  [0xc0, 0x80],
  [0xe0, 0x80, 0x80],
  [0xed, 0xa0, 0x80],
  [0xf4, 0x90, 0x80, 0x80],
  [0xf5, 0x80, 0x80, 0x80],
  [0xe2, 0x82],
  [0xff],
])
  add(`utf8-${Buffer.from(bytes).toString("hex")}`, [
    ...enc.encode("<a>"),
    ...bytes,
    ...enc.encode("</a>"),
  ]);
const generated = JSON.parse(
  read("testdata/cross-platform/bbs-model-vectors.json"),
).cases;
for (const c of generated.filter((c) => c.xml))
  add(`authored/${c.name}`, c.xml);
const paths = [
  sourcePath,
  "web/src/project/serialization/bbsXml.ts",
  "testdata/cross-platform/bbs-model-vectors.json",
];
const sources = Object.fromEntries(
  paths.map((p) => [p, createHash("sha256").update(read(p)).digest("hex")]),
);
const text = JSON.stringify({ version: 1, sources, cases }, null, 2) + "\n",
  target = new URL("testdata/cross-platform/bbs-xml-read-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(target, text);
else
  assert.equal(
    readFileSync(target, "utf8"),
    text,
    "Regenerate model XML validation vectors",
  );
console.log(
  JSON.stringify({
    cases: cases.length,
    accepted: cases.filter((c) => c.expected).length,
  }),
);
