// Independent production-browser expectations for signature-first STL/OBJ/AMF/
// ZIP model decoding (`decodeModelImport`). Real model files shipped in this
// repository plus authored edge cases for detection, every decoder, compressed
// containers, archives and limits. Accepted rows record the complete decoded
// structure: names and notices as exact UTF-16, transforms and unit scales as
// IEEE-754 bits, and mesh payloads as SHA-256 digests of their little-endian
// Float32/Uint32 arrays. Refusals record the error class, reason and format.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, gzipSync, zipSync } from "../../web/node_modules/fflate/esm/index.mjs";
import {
  decodeModelImport,
  MalformedModelSourceError,
  UnsupportedModelFormatError,
} from "../../web/src/project/import/formats/index.ts";

// fflate stamps ZIP members (local DOS time) and gzip headers with the clock;
// pin both so the corpus is reproducible.
process.env.TZ = "UTC";
const MTIME = new Date("2026-01-01T00:00:00Z");
const root = new URL("../../", import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const utf8 = (text) => new TextEncoder().encode(text);
const units = (text) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
// Well-formed text stays a JSON string; lone surrogates need unit arrays.
const encoded = (text) => (text.isWellFormed() ? text : units(text));
const bits = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true).toString(16).padStart(16, "0");
};
const littleEndian = (array) => {
  const view = new DataView(new ArrayBuffer(array.length * 4));
  array.forEach((value, i) =>
    array instanceof Float32Array ? view.setFloat32(i * 4, value, true) : view.setUint32(i * 4, value, true),
  );
  return new Uint8Array(view.buffer);
};

function expectation(bytes, filename, limits) {
  try {
    const decoded = decodeModelImport(bytes, { filename, ...(limits ? { limits } : {}) });
    return {
      ok: {
        format: decoded.format,
        filename: encoded(decoded.filename),
        unitScaleToMm: bits(decoded.unitScaleToMm),
        sourceUnit: decoded.sourceUnit,
        objects: decoded.objects.map((object) => ({
          name: encoded(object.name),
          instances: object.instances.map(({ transform: t }) =>
            [...t.translationMm, ...t.rotation, ...t.scale].map(bits),
          ),
          volumes: object.volumes.map((volume) => ({
            name: encoded(volume.name),
            role: volume.role,
            ...(volume.colorHex === undefined ? {} : { colorHex: volume.colorHex }),
            ...(volume.materialName === undefined ? {} : { materialName: encoded(volume.materialName) }),
            vertices: volume.mesh.positions.length / 3,
            triangles: volume.mesh.indices.length / 3,
            positionsSha256: sha256(littleEndian(volume.mesh.positions)),
            indicesSha256: sha256(littleEndian(volume.mesh.indices)),
          })),
        })),
        notices: decoded.notices.map((n) => [n.kind, n.code, encoded(n.path), encoded(n.message)]),
      },
    };
  } catch (error) {
    if (error instanceof UnsupportedModelFormatError) return { error: ["unsupported", error.reasonCode, error.format ?? null] };
    if (error instanceof MalformedModelSourceError) return { error: ["malformed", error.reasonCode, error.format ?? null] };
    throw error;
  }
}

const cases = [];
const add = (name, bytes, filename, limits) =>
  cases.push({
    name,
    filename: encoded(filename),
    bytesBase64: Buffer.from(bytes).toString("base64"),
    ...(limits ? { limits } : {}),
    expected: expectation(bytes, filename, limits),
  });

// ---- Geometry builders -------------------------------------------------------
const CORNERS = [
  [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
  [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
];
const FACES = [
  [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
  [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
];
const CUBE = FACES.map((f) => f.map((i) => CORNERS[i]));
function binaryStl(triangles, { header = "orcaxr fixture", declared = triangles.length, trailing = 0, headerBytes } = {}) {
  const bytes = new Uint8Array(84 + triangles.length * 50 + trailing);
  bytes.set(headerBytes ?? utf8(header).subarray(0, 80), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, declared, true);
  triangles.forEach((triangle, index) => {
    let offset = 84 + index * 50 + 12;
    for (const corner of triangle) {
      for (const value of corner) {
        view.setFloat32(offset, value, true);
        offset += 4;
      }
    }
  });
  return bytes;
}
function asciiStl(solids, { eol = "\n", vertex = "vertex", facet = "facet normal 0 0 0" } = {}) {
  const lines = [];
  for (const { name, triangles } of solids) {
    lines.push(name === undefined ? "solid" : `solid ${name}`);
    for (const triangle of triangles) {
      lines.push(`  ${facet}`, "    outer loop");
      for (const c of triangle) lines.push(`      ${vertex} ${c[0]} ${c[1]} ${c[2]}`);
      lines.push("    endloop", "  endfacet");
    }
    lines.push(name === undefined ? "endsolid" : `endsolid ${name}`);
  }
  return utf8(lines.join(eol) + eol);
}
const objCube = (prefix = "", faces = FACES.map((f) => `f ${f.map((i) => i + 1).join(" ")}`)) =>
  `${prefix}${CORNERS.map((c) => `v ${c.join(" ")}`).join("\n")}\n${faces.join("\n")}\n`;
// Detection sniffs only the first 400 lines of an 8 KiB probe; padding moves
// decoder-only content (unknown keywords, control bytes) past that window.
const PAD = "# padding that moves the following lines past the detection probe\n".repeat(400);
const objPadded = (body) => `${CORNERS.map((c) => `v ${c.join(" ")}`).join("\n")}\n${PAD}${body}`;
const amfVertices = (corners = CORNERS) =>
  `<vertices>${corners
    .map((c) => `<vertex><coordinates><x>${c[0]}</x><y>${c[1]}</y><z>${c[2]}</z></coordinates></vertex>`)
    .join("")}</vertices>`;
const amfTriangles = (faces = FACES) =>
  faces.map((f) => `<triangle><v1>${f[0]}</v1><v2>${f[1]}</v2><v3>${f[2]}</v3></triangle>`).join("");
const amfObject = (id, { volumes = [{ faces: FACES }], metadata = "", corners = CORNERS } = {}) =>
  `<object id="${id}">${metadata}<mesh>${amfVertices(corners)}${volumes
    .map(
      (v) =>
        `<volume${v.material ? ` materialid="${v.material}"` : ""}>${v.metadata ?? ""}${amfTriangles(v.faces)}</volume>`,
    )
    .join("")}</mesh></object>`;
const amf = (body, { unit, declaration = '<?xml version="1.0" encoding="UTF-8"?>\n', rootName = "amf" } = {}) =>
  utf8(`${declaration}<${rootName}${unit === undefined ? "" : ` unit="${unit}"`}>${body}</${rootName}>`);
const zip = (files, level = 6) => zipSync(Object.fromEntries(Object.entries(files)), { level, mtime: MTIME });
const gzip = (bytes, options = {}) => gzipSync(bytes, { mtime: MTIME, ...options });

// ---- Detection ---------------------------------------------------------------
add("detect/empty", new Uint8Array(0), "empty.stl");
add("detect/noise", Uint8Array.from({ length: 512 }, (_, i) => ((i * 37 + 11) % 251) || 0xfe), "noise.bin");
add("detect/noise-stl", Uint8Array.from({ length: 50 }, (_, i) => (i * 37 + 11) % 251), "noise.stl");
add("detect/text-unknown", utf8("hello world\nthis is not a model\n"), "readme");
add("detect/text-stl-mismatch", utf8("hello world\n"), "hello.stl");
add("detect/text-obj-mismatch", utf8("hello world\n"), "hello.obj");
add("detect/project-3mf-content-types", zip({ "[Content_Types].xml": utf8("<Types/>"), "3D/3dmodel.model": utf8("<model/>") }), "box.3mf");
add("detect/project-3mf-model-first", zip({ "3D/3dmodel.model": utf8("<model/>") }), "box.zip");
add("detect/project-3mf-extension", zip({ "notes.txt": utf8("x") }), "box.3mf");
add("detect/step", utf8("ISO-10303-21;\nHEADER;\nENDSEC;\n"), "part.step");
add("detect/step-spaced-lowercase", utf8("  iso-10303-21 \t;\n"), "part");
add("detect/step-short", utf8("STEP;"), "part.stp");
add("detect/svg", utf8('<?xml version="1.0"?><!-- c --><svg:svg xmlns:svg="x"/>'), "logo.svg");
add("detect/svg-as-stl", utf8("<svg/>"), "logo.stl");
add("detect/xml-unknown", utf8("<root/>"), "data.xml");
add("detect/xml-unknown-amf-extension", utf8("<root/>"), "data.amf");
add("detect/gcode", utf8("; generated\nG28\nG1 X10 Y10\n"), "print.gcode");
add("detect/gcode-lowercase", utf8("m104 S200\n"), "print");
add("detect/gcode-not-boundary", utf8("G10 X1\nG100\n"), "print.txt");
add("detect/gcode-as-stl", utf8("G1 X0\n"), "print.stl");
add("detect/binary-stl-as-obj", binaryStl(CUBE), "cube.obj");
add("detect/ascii-stl-as-amf", asciiStl([{ name: "c", triangles: CUBE }]), "cube.amf");
add("detect/prototype-extension", binaryStl(CUBE), "cube.constructor");
add("detect/proto-extension", binaryStl(CUBE), "cube.__proto__");
add("detect/uppercase-extension", binaryStl(CUBE), "CUBE.STL");
add("detect/unicode-extension", binaryStl(CUBE), "cube.ΣΤΛ");
add("detect/no-extension-binary", binaryStl(CUBE), "cube");
add("detect/dot-file", binaryStl(CUBE), ".stl");
add("detect/trailing-dot", binaryStl(CUBE), "cube.");
add("detect/control-byte-text", utf8("solid x\u0001\nendsolid x\n"), "ctl.txt");
add("detect/control-byte-stl", Uint8Array.from([...utf8("solid x\u0001"), ...new Uint8Array(90)]), "ctl.stl");
add("detect/bom-ascii-stl", Uint8Array.from([0xef, 0xbb, 0xbf, ...asciiStl([{ name: "bom", triangles: CUBE }])]), "bom.stl");
add("detect/double-bom-obj", Uint8Array.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...utf8(objCube())]), "bom.obj");
add("detect/solid-without-facets-stl", utf8("solid lonely\n"), "lonely.stl");
add("detect/solid-without-facets-txt", utf8("solid lonely\n"), "lonely.txt");
add("detect/solid-word-boundary", utf8("solidify\nendsolid\n"), "x.dat");
add("detect/ascii-stl-outer-loop-only", utf8("SOLID a\nOuter  Loop\n"), "loop");
add("detect/obj-heuristic", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"), "tri");
add("detect/obj-two-lines", utf8("v 0 0 0\nf 1 1 1\n"), "tri.txt");
add("detect/obj-unknown-line", utf8("v 0 0 0\nv 1 0 0\nfoo\nf 1 2 3\n"), "tri.obj");
add("detect/obj-uppercase", utf8("V 0 0 0\nV 1 0 0\nV 0 1 0\nF 1 2 3\n"), "tri.obj");
add("detect/obj-past-probe", utf8(`${"# padding comment line\n".repeat(400)}v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n`), "late.obj");
add("detect/text-probe-utf8-split", utf8(`${"#".repeat(8191)}é\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n`), "split.obj");
add("detect/gzip-no-extension", gzip(amf(amfObject("1"))), "blob");
add("detect/zip-as-stl", zip({ "a.stl": binaryStl(CUBE) }), "pack.stl");

// ---- Binary STL --------------------------------------------------------------
add("stl-binary/cube", binaryStl(CUBE), "cube.stl");
add("stl-binary/header-nul-label", binaryStl(CUBE, { header: "label\u0000trailing" }), "label.stl");
add("stl-binary/header-controls", binaryStl(CUBE, { header: "  a\tb\u0007c  " }), "ctl.stl");
add("stl-binary/header-unicode", binaryStl(CUBE, { header: "Würfel – 立方体" }), "u.stl");
add("stl-binary/header-invalid-utf8", binaryStl(CUBE, { headerBytes: Uint8Array.from([0x41, 0xff, 0xc3, 0x28, 0xed, 0xa0, 0x80, 0x42]) }), "bad.stl");
add("stl-binary/header-bom", binaryStl(CUBE, { headerBytes: Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8("bom label")]) }), "bom.stl");
add("stl-binary/header-empty", binaryStl(CUBE, { header: "" }), "empty-header.stl");
add("stl-binary/header-solid", binaryStl(CUBE, { header: "solid exported by cad" }), "solid.stl");
add("stl-binary/zero-triangles", binaryStl([]), "zero.stl");
add("stl-binary/declared-more", binaryStl(CUBE.slice(0, 4), { declared: 12 }), "short.stl");
add("stl-binary/declared-less-trailing", binaryStl(CUBE, { declared: 10 }), "long.stl");
add("stl-binary/trailing-padding", binaryStl(CUBE, { trailing: 20 }), "pad.stl");
add("stl-binary/trailing-padding-noext", binaryStl(CUBE, { trailing: 20 }), "pad");
add("stl-binary/short-header", new Uint8Array(60), "tiny.stl");
add("stl-binary/degenerate", binaryStl([...CUBE, [CORNERS[0], CORNERS[0], CORNERS[1]], [CORNERS[2], CORNERS[3], CORNERS[2]]]), "deg.stl");
add("stl-binary/all-degenerate", binaryStl([[CORNERS[0], CORNERS[0], CORNERS[0]]]), "deg.stl");
add("stl-binary/nan", binaryStl([[[0, 0, 0], [1, NaN, 0], [0, 1, 0]]]), "nan.stl");
add("stl-binary/infinity", binaryStl([[[0, 0, 0], [Infinity, 0, 0], [0, 1, 0]]]), "inf.stl");
add("stl-binary/signed-zero", binaryStl([[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[-0, 0, 0], [1, 0, 0], [0, 0, 1]]]), "zero.stl");
add("stl-binary/subnormal", binaryStl([[[1e-40, 0, 0], [1, 0, 0], [0, 1, 0]]]), "sub.stl");
add("stl-binary/limit-triangles", binaryStl(CUBE), "cube.stl", { maxTriangles: 5 });
add("stl-binary/limit-triangles-degenerate", binaryStl([...CUBE.slice(0, 2), [CORNERS[0], CORNERS[0], CORNERS[1]]]), "cube.stl", { maxTriangles: 2 });
add("stl-binary/limit-vertices", binaryStl(CUBE), "cube.stl", { maxVertices: 7 });
add("stl-binary/limit-bytes", binaryStl(CUBE), "cube.stl", { maxBytes: 600 });
add("stl-binary/name-sliced", binaryStl(CUBE), "a-very-long-name.stl", { maxNameLength: 6 });
add("stl-binary/name-surrogate-split", binaryStl(CUBE), "😀😀.stl", { maxNameLength: 3 });
add("stl-binary/path-segments", binaryStl(CUBE), "dir/sub\\  spaced name .stl");
add("stl-binary/empty-filename", binaryStl(CUBE), "");
add("stl-binary/control-filename", binaryStl(CUBE), "a\u0001b.stl");
add("stl-binary/multi-dot", binaryStl(CUBE), "part.v2.final.stl");

// ---- ASCII STL ---------------------------------------------------------------
add("stl-ascii/cube", asciiStl([{ name: "cube", triangles: CUBE }]), "cube.stl");
add("stl-ascii/crlf-uppercase", asciiStl([{ name: "CUBE", triangles: CUBE }], { eol: "\r\n", vertex: "VERTEX", facet: "FACET NORMAL 0 0 1" }), "cube.stl");
add("stl-ascii/two-solids", asciiStl([{ name: "left", triangles: CUBE.slice(0, 6) }, { name: "right", triangles: CUBE.slice(6) }]), "pair.stl");
add("stl-ascii/six-solids", asciiStl(Array.from({ length: 6 }, (_, i) => ({ name: i === 2 ? undefined : `s${i}`, triangles: [CUBE[i]] }))), "many.stl");
add("stl-ascii/unnamed", asciiStl([{ triangles: CUBE }]), "anon.stl");
add("stl-ascii/exponent-hex", utf8("solid e\nfacet normal 0 0 0\nouter loop\nvertex 1e1 0x10 -0\nvertex 0 1.5E-1 .5\nvertex 2. 0 0\nendloop\nendfacet\nendsolid\n"), "num.stl");
add("stl-ascii/tabs-and-spaces", utf8("solid t\n\tfacet normal 0 0 0\n\t\touter loop\n\t\t\tvertex\t0\t0\t0\n\t\t\tvertex  1   0 0\n\t\t\tvertex 0 1 0 extra\n\t\tendloop\n\tendfacet\nendsolid t"), "tabs.stl");
add("stl-ascii/unicode-spaces", utf8("solid u name\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1　0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid\n"), "space.stl");
add("stl-ascii/unicode-name", asciiStl([{ name: "Würfel 立方体", triangles: CUBE }]), "u.stl");
add("stl-ascii/non-numeric", utf8("solid n\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex a 0 0\nvertex 0 1 0\nendloop\nendfacet\n"), "nan.stl");
add("stl-ascii/infinity", utf8("solid n\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex Infinity 0 0\nvertex 0 1 0\nendloop\nendfacet\n"), "inf.stl");
add("stl-ascii/two-vertices", utf8("solid n\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nendloop\nendfacet\n"), "two.stl");
add("stl-ascii/four-vertices", utf8("solid n\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nvertex 1 1 0\nendloop\nendfacet\n"), "four.stl");
add("stl-ascii/vertex-outside", utf8("solid n\nvertex 0 0 0\n"), "out.stl");
add("stl-ascii/vertex-short", utf8("solid n\nfacet normal 0 0 0\nvertex 0 0\n"), "short.stl");
add("stl-ascii/unknown-keyword", utf8("solid n\ncolor 1 0 0\n"), "kw.stl");
add("stl-ascii/unterminated", utf8("solid n\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\n"), "open.stl");
add("stl-ascii/no-endsolid", utf8("solid n\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n"), "noend.stl");
add("stl-ascii/degenerate", asciiStl([{ name: "d", triangles: [...CUBE, [CORNERS[1], CORNERS[1], CORNERS[2]]] }]), "deg.stl");
add("stl-ascii/empty", utf8("solid empty\nendsolid empty\n"), "empty.stl");
add("stl-ascii/limit", asciiStl([{ name: "c", triangles: CUBE }]), "cube.stl", { maxTriangles: 11 });
add("stl-ascii/cr-only-lines", utf8("solid r\rfacet normal 0 0 0\r"), "cr.stl");
add("stl-ascii/vertex-prefix-keyword", utf8("solid v\nfacet normal 0 0 0\nouter loop\nvertexes 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n"), "prefix.stl");
add("stl-ascii/solid-trailing-space-name", utf8("solid   \nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nsolid second\n"), "names.stl");

// ---- OBJ ---------------------------------------------------------------------
add("obj/cube", utf8(objCube()), "cube.obj");
add("obj/objects", utf8(`${CORNERS.map((c) => `v ${c.join(" ")}`).join("\n")}\no First\nf 1 2 3\nf 1 3 4\no\nf 5 6 7\no   Third  \nf 1 2 6\n`), "multi.obj");
add("obj/groups-and-materials", utf8(`mtllib parts.mtl\n${CORNERS.map((c) => `v ${c.join(" ")}`).join("\n")}\ng body\nf 1 2 3\nusemtl Red\nf 1 3 4\ng lid\nf 5 6 7\nusemtl\nf 5 7 8\no next\nf 1 5 6\n`), "groups.obj");
add("obj/negative-and-slashes", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf -4/1/1 -3//2 -2/3\nf 1/1 2/2 4/4\n"), "neg.obj");
add("obj/polygons", utf8("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0.5 1.5 0\nf 1 2 3 4\nf 1 2 3 5 4\n"), "poly.obj");
add("obj/vertex-colors", utf8("v 0 0 0 1 0 0\nv 1 0 0 0 1 0\nv 0 1 0 1 1 1 0.5\nv 0 0 1 255 128 x\nf 1 2 3\nf 1 2 4\n"), "rgb.obj");
add("obj/curves-and-ignored", utf8(objPadded("vn 0 0 1\nvt 0 0\nvp 0 0\ns 1\nl 1 2\np 1\ncurv 0 1 1 2\ncurv2 1 2\nsurf 0 1 0 1 1 2\nf 1 2 3\n")), "curves.obj");
add("obj/single-curve", utf8(objPadded("l 1 2\nf 1 2 3\n")), "curve.obj");
add("obj/comments-and-crlf", utf8("# header\r\nv 0 0 0 # origin\r\nv 1 0 0\r\nv 0 1 0\r\n\r\nf 1 2 3#face\r\n"), "crlf.obj");
add("obj/unsupported-keyword", utf8(objPadded("f 1 2 3\nbogus 1\n")), "bad.obj");
add("obj/unsupported-keyword-detected", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\nbogus 1\n"), "bad.obj");
add("obj/vertex-two-coords", utf8("v 0 0 0\nv 1 0 0\nv 0 1\nf 1 2 3\n"), "bad.obj");
add("obj/vertex-non-numeric", utf8("v 0 0 0\nv 1 0 0\nv 0 one 0\nf 1 2 3\n"), "bad.obj");
add("obj/face-zero", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 1 2\n"), "bad.obj");
add("obj/face-range", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 4\n"), "bad.obj");
add("obj/face-negative-range", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\nf -1 -2 -4\n"), "bad.obj");
add("obj/face-two-corners", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2\n"), "bad.obj");
add("obj/face-garbage-corner", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 x3\n"), "bad.obj");
add("obj/face-parseint-prefix", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3abc\n"), "prefix.obj");
add("obj/no-faces", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\n"), "nofaces.obj");
add("obj/only-degenerate", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 1 2\n"), "deg.obj");
add("obj/degenerate-mixed", utf8(objCube("", [...FACES.map((f) => `f ${f.map((i) => i + 1).join(" ")}`), "f 1 1 2", "f 3 3 3"])), "deg.obj");
add("obj/duplicate-coordinates-weld", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 0\nf 1 2 3\nf 4 3 2\n"), "weld.obj");
add("obj/keyword-case", utf8(objPadded("USEMTL Blue\nF 1 2 3\nO Upper\nV 5 5 5\nF 1 2 -1\n")), "case.obj");
add("obj/names-controls-unicode", utf8(objPadded("o \u0007Name\u0001 立方\nusemtl Mat\u0002 X\nf 1 2 3\ng 😀 group\nf 1 3 4\n")), "names.obj");
add("obj/control-bytes-detected", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\no \u0007Name\nf 1 2 3\n"), "names.obj");
add("obj/long-names", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\no ObjectNameThatIsLong\ng GroupNameThatIsLong\nf 1 2 3\n"), "long.obj", { maxNameLength: 8 });
add("obj/long-name-surrogate", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\no ab😀cd\nf 1 2 3\n"), "long.obj", { maxNameLength: 3 });
add("obj/mtllib-unresolved", utf8(`mtllib missing.mtl other.mtl\n${objCube()}`), "mat.obj");
add("obj/mtllib-empty", utf8(`mtllib\n${objCube()}`), "mat.obj");
add("obj/numbers", utf8("v 1e1 0x10 -0\nv .5 2. +3\nv 0b11 0o7 1E-2\nf 1 2 3\n"), "num.obj");
add("obj/vertex-w", utf8("v 0 0 0 1\nv 1 0 0 1\nv 0 1 0 1\nf 1 2 3\n"), "w.obj");
add("obj/infinity-vertex", utf8("v 0 0 0\nv Infinity 0 0\nv 0 1 0\nf 1 2 3\n"), "inf.obj");
add("obj/huge-vertex-f32-overflow", utf8("v 0 0 0\nv 1e39 0 0\nv 0 1 0\nf 1 2 3\n"), "huge.obj");
add("obj/limit-objects", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\no a\nf 1 2 3\no b\nf 1 2 3\n"), "lim.obj", { maxObjects: 1 });
add("obj/limit-volumes", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\ng a\nf 1 2 3\ng b\nf 1 2 3\n"), "lim.obj", { maxVolumesPerObject: 1 });
add("obj/limit-vertices", utf8(objCube()), "lim.obj", { maxVertices: 7 });
add("obj/limit-builder-vertices", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\nf 1 2 4\n"), "lim.obj", { maxVertices: 4 });
add("obj/limit-triangles", utf8(objCube()), "lim.obj", { maxTriangles: 3 });
add("obj/empty-volume-skipped", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\ng empty\nf 1 1 1\ng full\nf 1 2 3\n"), "skip.obj");
add("obj/keyword-tab", utf8("v\t0 0 0\nv\t1 0 0\nv\t0 1 0\nf\t1 2 3\n"), "tab.obj");
add("obj/unicode-space-separator", utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"), "nbsp.obj");

// ---- AMF ---------------------------------------------------------------------
add("amf/cube", amf(amfObject("1")), "cube.amf");
add("amf/no-declaration-uppercase", amf(amfObject("1"), { unit: "Inch", declaration: "", rootName: "AMF" }), "inch.amf");
for (const unit of ["millimetre", "micron", "meter", "cm", "feet", "ft", "in", " MM "])
  add(`amf/unit-${unit.trim()}`, amf(amfObject("1"), { unit }), "units.amf");
add("amf/unit-unknown", amf(amfObject("1"), { unit: "furlong" }), "bad.amf");
add("amf/unit-prototype", amf(amfObject("1"), { unit: "constructor" }), "proto.amf");
add("amf/unit-proto", amf(amfObject("1"), { unit: "__proto__" }), "proto.amf");
add("amf/prototype-attributes", utf8(`<amf unit="mm" toString="a" constructor="b" __proto__="c">${amfObject("1")}</amf>`), "attrs.amf");
add(
  "amf/metadata-and-materials",
  amf(
    `<metadata type="cad">Fusion</metadata><material id="2"><metadata type="name">Red PLA</metadata><color><r>1</r><g>0.2</g><b>0</b><a>1</a></color></material>` +
      `<material id="3"><color><r>200</r><g>x</g></color></material>` +
      amfObject("1", {
        metadata: '<metadata type="name">Body</metadata><metadata type="Units">mm</metadata>',
        volumes: [
          { faces: FACES.slice(0, 6), material: "2", metadata: '<metadata type="name">Lower</metadata>' },
          { faces: FACES.slice(6), material: "3", metadata: '<metadata type="slic3r.modifier">1</metadata><metadata type="slic3r.extruder">2</metadata>' },
          { faces: FACES.slice(0, 2), material: "9", metadata: '<metadata type="SLIC3R.MODIFIER">0</metadata>' },
          { faces: FACES.slice(2, 4) },
        ],
      }),
  ),
  "materials.amf",
);
add(
  "amf/constellation",
  amf(
    amfObject("a") +
      amfObject("b", { metadata: '<metadata type="name">B</metadata>' }) +
      `<constellation id="c"><instance objectid="a"><deltax>10</deltax><deltay>-5.5</deltay><deltaz>0</deltaz><rx>90</rx><ry>45</ry><rz>30</rz></instance>` +
      `<instance objectid="a"><deltax>bad</deltax><rz>180</rz><rx>x</rx></instance>` +
      `<instance objectid="b"><metadata type="name">ignored</metadata><metadata type="note">n</metadata><rz>-0</rz></instance></constellation>`,
    { unit: "inch" },
  ),
  "scene.amf",
);
add("amf/constellation-unknown-object", amf(amfObject("a") + '<constellation><instance objectid="z"/></constellation>'), "bad.amf");
add("amf/constellation-instance-limit", amf(amfObject("a") + '<constellation><instance objectid="a"/><instance objectid="a"/></constellation>'), "lim.amf", { maxInstancesPerObject: 1 });
add("amf/constellation-total-limit", amf(amfObject("a") + '<constellation><instance objectid="a"/><instance objectid="a"/><instance objectid="a"/></constellation>'), "lim.amf", { maxObjects: 1, maxInstancesPerObject: 2 });
add("amf/instance-without-objectid", amf(amfObject("a") + "<constellation><instance/></constellation>"), "bad.amf");
add("amf/entities", amf(amfObject("1", { metadata: '<metadata type="name">A&amp;B &lt;&gt; &quot;&apos; &#65;&#x42; &#xD800;x &#1a; &#x; &#X41; &</metadata>' })), "ent.amf");
add("amf/entity-astral", amf(amfObject("1", { metadata: '<metadata type="name">&#x1F600;&#128512;</metadata>' })), "ent.amf");
add("amf/entity-undeclared", amf(amfObject("1", { metadata: '<metadata type="name">&nbsp;</metadata>' })), "bad.amf");
add("amf/entity-unterminated", amf(amfObject("1", { metadata: '<metadata type="name">&amp x</metadata>' })), "bad.amf");
add("amf/entity-zero", amf(amfObject("1", { metadata: '<metadata type="name">&#0;</metadata>' })), "bad.amf");
add("amf/entity-too-large", amf(amfObject("1", { metadata: '<metadata type="name">&#x110000;</metadata>' })), "bad.amf");
add("amf/entity-in-attribute", amf(amfObject("1&amp;2")), "attr.amf");
add("amf/cdata-comments-pi", amf(`<!-- note --><?pi data?>${amfObject("1", { metadata: '<metadata type="name"><![CDATA[Raw &amp; <name>]]></metadata>' })}`), "cdata.amf");
add("amf/doctype", utf8('<?xml version="1.0"?><!DOCTYPE amf><amf>' + amfObject("1") + "</amf>"), "dtd.amf");
add("amf/mismatched", utf8("<amf><object id='1'></amf></object>"), "bad.amf");
add("amf/multiple-roots", utf8(`<amf>${amfObject("1")}</amf><amf/>`), "bad.amf");
add("amf/text-outside-root", utf8(`junk<amf>${amfObject("1")}</amf>`), "bad.amf");
add("amf/text-after-root", utf8(`<amf>${amfObject("1")}</amf>trailing text`), "trail.amf");
add("amf/text-after-root-then-tag", utf8(`<amf>${amfObject("1")}</amf>trailing<x/>`), "bad.amf");
add("amf/depth-limit", amf(amfObject("1")), "deep.amf", { maxXmlDepth: 5 });
add("amf/duplicate-attribute", utf8(`<amf unit="mm" unit="inch">${amfObject("1")}</amf>`), "bad.amf");
add("amf/case-duplicate-attribute", utf8(`<amf UNIT="inch" unit="mm">${amfObject("1")}</amf>`), "case.amf");
add("amf/namespaced-duplicate-attribute", utf8(`<amf a:unit="inch" unit="mm">${amfObject("1")}</amf>`), "bad.amf");
add("amf/unquoted-attribute", utf8(`<amf unit=mm>${amfObject("1")}</amf>`), "bad.amf");
add("amf/attribute-no-value", utf8(`<amf unit>${amfObject("1")}</amf>`), "bad.amf");
add("amf/self-closing-junk", utf8(`<amf>${amfObject("1")}<metadata type="x"/ junk></amf>`), "bad.amf");
add("amf/invalid-element-name", utf8(`<amf>${amfObject("1")}<1bad/></amf>`), "bad.amf");
add("amf/unterminated-tag", utf8(`<amf>${amfObject("1")}<metadata type="x"`), "bad.amf");
add("amf/unterminated-comment", utf8(`<amf>${amfObject("1")}<!-- oops</amf>`), "bad.amf");
add("amf/unterminated-cdata", utf8(`<amf>${amfObject("1")}<![CDATA[ oops</amf>`), "bad.amf");
add("amf/unterminated-pi", utf8(`<?xml version="1.0"<amf/>`), "bad.amf");
add("amf/unclosed", utf8(`<amf>${amfObject("1")}`), "bad.amf");
add("amf/quoted-gt-in-attribute", utf8(`<amf unit='m>m'>${amfObject("1")}</amf>`), "bad.amf");
add("amf/namespaced-elements", utf8(`<a:amf xmlns:a="x" a:unit="mm"><a:object id="1"><a:mesh>${amfVertices()}<a:volume>${amfTriangles()}</a:volume></a:mesh></a:object></a:amf>`), "ns.amf");
add("amf/vertex-out-of-range", amf(amfObject("1", { volumes: [{ faces: [[0, 1, 8]] }] })), "bad.amf");
add("amf/vertex-negative", amf(amfObject("1", { volumes: [{ faces: [[0, 1, -1]] }] })), "bad.amf");
add("amf/vertex-negative-zero", utf8(`<amf><object id="1"><mesh>${amfVertices()}<volume><triangle><v1>-0</v1><v2>1</v2><v3>2</v3></triangle></volume></mesh></object></amf>`), "negzero.amf");
add("amf/triangle-missing", utf8(`<amf><object id="1"><mesh>${amfVertices()}<volume><triangle><v1>0</v1><v2>1</v2></triangle></volume></mesh></object></amf>`), "bad.amf");
add("amf/coordinate-missing", utf8(`<amf><object id="1"><mesh><vertices><vertex><coordinates><x>0</x><y>0</y></coordinates></vertex></vertices></mesh></object></amf>`), "bad.amf");
add("amf/coordinate-non-numeric", utf8(`<amf><object id="1"><mesh><vertices><vertex><coordinates><x>0</x><y>a</y><z>0</z></coordinates></vertex></vertices></mesh></object></amf>`), "bad.amf");
add("amf/coordinate-forms", amf(amfObject("1", { corners: [[" 1e1 ", "0x10", "-0"], [".5", "2.", "+3"], ["0", "1", "0"]], volumes: [{ faces: [[0, 1, 2]] }] })), "num.amf");
add("amf/triangle-index-forms", utf8(`<amf><object id="1"><mesh>${amfVertices()}<volume><triangle><v1> 0 </v1><v2>1abc</v2><v3>2.9</v3></triangle></volume></mesh></object></amf>`), "idx.amf");
add("amf/object-no-id", utf8(`<amf><object><mesh/></object></amf>`), "bad.amf");
add("amf/object-blank-id", utf8(`<amf><object id="  "><mesh/></object></amf>`), "bad.amf");
add("amf/duplicate-object", amf(amfObject("1") + amfObject(" 1 ")), "bad.amf");
add("amf/volume-outside-object", utf8("<amf><volume/></amf>"), "bad.amf");
add("amf/material-no-id", utf8(`<amf><material/>${amfObject("1")}</amf>`), "bad.amf");
add("amf/no-objects", utf8("<amf><metadata type='x'>y</metadata></amf>"), "bad.amf");
add("amf/no-printable-volumes", amf(amfObject("1", { volumes: [{ faces: [] }, { faces: [[0, 0, 1]] }] })), "empty.amf");
add("amf/welded-degenerate", amf(amfObject("1", { corners: [...CORNERS, [0, 0, 0]], volumes: [{ faces: [...FACES, [0, 8, 1]] }] })), "weld.amf");
add("amf/object-limit", amf(amfObject("1") + amfObject("2")), "lim.amf", { maxObjects: 1 });
add("amf/volume-limit", amf(amfObject("1", { volumes: [{ faces: FACES }, { faces: FACES }] })), "lim.amf", { maxVolumesPerObject: 1 });
add("amf/vertex-limit", amf(amfObject("1")), "lim.amf", { maxVertices: 7 });
add("amf/triangle-limit", amf(amfObject("1")), "lim.amf", { maxTriangles: 11 });
add("amf/name-fallbacks", amf(amfObject("obj-id", { volumes: [{ faces: FACES.slice(0, 4), material: "m" }, { faces: FACES.slice(4) }] }) + amfObject("2", { metadata: '<metadata type="name">  </metadata>' })), "fallback.amf");
add("amf/metadata-split-text", amf(amfObject("1", { metadata: '<metadata type="name">first<!-- c -->second</metadata><metadata>untyped</metadata><metadata type="">blank</metadata>' })), "split.amf");
add("amf/kelvin-closing-tag", utf8(`<amf>${amfObject("1")}<kx></\u212Ax></amf>`), "kelvin.amf");
add("amf/object-inside-open-volume", utf8(`<amf><object id="a"><mesh>${amfVertices()}<volume><object id="b"></object>${amfTriangles()}</volume></mesh></object></amf>`), "nested.amf");
add("amf/bom", Uint8Array.from([0xef, 0xbb, 0xbf, ...amf(amfObject("1"))]), "bom.amf");
add("amf/single-quotes-and-spacing", utf8(`<amf  unit = 'mm' ><object id = '7' ><mesh>${amfVertices()}<volume>${amfTriangles()}</volume></mesh></object  ></amf>`), "space.amf");

// ---- Compressed AMF ----------------------------------------------------------
const amfDoc = amf(amfObject("1", { metadata: '<metadata type="name">Packed</metadata>' }), { unit: "cm" });
add("amf-gzip/basic", gzip(amfDoc), "packed.amfz");
add("amf-gzip/gz-extension", gzip(amfDoc), "Packed.AMF.GZ");
add("amf-gzip/amf-extension", gzip(amfDoc), "packed.amf");
add("amf-gzip/fname", gzip(amfDoc, { filename: "inner.amf", mtime: 0 }), "packed.amfz");
// fflate never checks the CRC and sizes its output by the trailer length.
const withTrailer = (bytes, edit) => {
  const copy = Uint8Array.from(bytes);
  edit(new DataView(copy.buffer), copy.length);
  return copy;
};
add("amf-gzip/bad-crc", withTrailer(gzip(amfDoc), (v, n) => v.setUint32(n - 8, 0xdeadbeef, true)), "packed.amfz");
add("amf-gzip/length-larger", withTrailer(gzip(amfDoc), (v, n) => v.setUint32(n - 4, amfDoc.length + 1000, true)), "packed.amfz");
add("amf-gzip/length-smaller", withTrailer(gzip(amfDoc), (v, n) => v.setUint32(n - 4, 50, true)), "packed.amfz");
const spaced = Uint8Array.from([...amfDoc, ...utf8(" ".repeat(300))]);
add("amf-gzip/length-cuts-trailing-space", withTrailer(gzip(spaced), (v, n) => v.setUint32(n - 4, amfDoc.length + 10, true)), "packed.amfz");
add("amf-gzip/empty-body", Uint8Array.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 16, 0, 0, 0]), "zeros.amfz");
add("amf-gzip/empty-body-over-limit", Uint8Array.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 1, 0]), "zeros.amfz", { maxBytes: 1000 });
const corrupt = gzip(amfDoc);
corrupt[12] = 0xff;
corrupt[13] = 0xff;
add("amf-gzip/corrupt-deflate", corrupt, "packed.amfz");
// FEXTRA, FCOMMENT and FHCRC header fields are skipped like fflate does.
const flagged = Uint8Array.from([0x1f, 0x8b, 0x08, 0x04 | 0x10 | 0x02, 0, 0, 0, 0, 0, 3, 3, 0, 1, 2, 3, ...utf8("note"), 0, 0xaa, 0xbb, ...deflateSync(amfDoc), 1, 2, 3, 4, 5, 6, 7, 8]);
add("amf-gzip/header-fields", flagged, "flags.amfz");
add("amf-gzip/second-member", Uint8Array.from([...gzip(amfDoc), ...gzip(utf8("<amf/>"))]), "two.amfz");
add("amf-gzip/truncated", gzip(amfDoc).subarray(0, 14), "packed.amfz");
add("amf-gzip/header-only", Uint8Array.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3]), "packed.amfz");
add("amf-gzip/expansion-limit", gzip(amf(amfObject("1", { metadata: `<metadata type="pad">${"x".repeat(5000)}</metadata>` }))), "packed.amfz", { maxBytes: 4000 });
add("amf-gzip/not-amf-inside", gzip(binaryStl(CUBE)), "packed.amfz");
add("amf-gzip/as-stl", gzip(amfDoc), "packed.stl");
add("amf-zip/single", zip({ "dir/model.amf": amfDoc, "readme.txt": utf8("hi") }), "packed.amf");
add("amf-zip/two-members", zip({ "a.amf": amfDoc, "b.AMF": amfDoc }), "packed.amfz");
add("amf-zip/no-member", zip({ "a.stl": binaryStl(CUBE) }), "packed.amf");

// ---- ZIP archives ------------------------------------------------------------
const mtl = utf8("# colours\nnewmtl Red  Paint\nKd 1 0 0\nnewmtl Green\nKd 0 0.5 0 # dim\nnewmtl Blue\nKd 0 0 1\nnewmtl\nKd 1 1 1\n");
const objWithMtl = utf8(`mtllib ./Materials/Paint.MTL missing.mtl\n${CORNERS.map((c) => `v ${c.join(" ")}`).join("\n")}\nusemtl Red  Paint\nf 1 2 3\nusemtl Red Paint\nf 1 3 4\nusemtl Blue\nf 5 6 7\nusemtl Green\nf 5 7 8\n`);
add(
  "zip/mixed",
  zip({
    "b/cube.stl": binaryStl(CUBE),
    "a/model.obj": objWithMtl,
    "materials/paint.mtl": mtl,
    "inch.amf": amf(amfObject("1", { metadata: '<metadata type="name">Inches</metadata>' }), { unit: "inch" }),
    "notes.txt": utf8("ignore me"),
    "nested.zip": zip({ "x.stl": binaryStl(CUBE) }),
    "README": utf8("no extension"),
    "dir/": new Uint8Array(0),
  }),
  "bundle.zip",
);
add("zip/stored", zip({ "a.stl": binaryStl(CUBE), "b.STL": asciiStl([{ name: "b", triangles: CUBE }]) }, 0), "stored.zip");
add("zip/unit-order", zip({ "m.amf": amf(amfObject("1"), { unit: "meter" }), "i.amf": amf(amfObject("1"), { unit: "inch" }), "z.stl": binaryStl(CUBE) }), "units.zip");
add("zip/sort-utf16", zip({ ".stl": binaryStl(CUBE), "\u{1F600}.stl": binaryStl(CUBE.slice(0, 2)), "Z.stl": binaryStl(CUBE.slice(0, 3)), "a.stl": binaryStl(CUBE.slice(0, 4)) }), "sort.zip");
add("zip/only-text", zip({ "a.txt": utf8("x"), "b.md": utf8("y") }), "text.zip");
add("zip/empty", zip({}), "empty.zip");
add("zip/failing-member", zip({ "good.stl": binaryStl(CUBE), "bad.obj": utf8("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 5\n") }), "fail.zip");
add("zip/undetectable-member", zip({ "good.stl": binaryStl(CUBE), "bad.obj": utf8("v 0 0 0\nf 1 2 3\n") }), "fail.zip");
add("zip/unsupported-member", zip({ "good.stl": binaryStl(CUBE), "fake.amf": utf8("not xml at all\n") }), "fail.zip");
add("zip/project-member", zip({ "inner.amf": zip({ "[Content_Types].xml": utf8("<Types/>") }) }), "proj.zip");
add("zip/unsafe-path", zip({ "../evil.stl": binaryStl(CUBE) }), "unsafe.zip");
add("zip/backslash-path", zip({ "dir\\evil.stl": binaryStl(CUBE) }), "unsafe.zip");
add("zip/member-limit", zip({ "a.stl": binaryStl(CUBE), "b.stl": binaryStl(CUBE), "c.stl": binaryStl(CUBE) }), "lim.zip", { maxArchiveMembers: 2 });
add("zip/object-limit", zip({ "a.stl": binaryStl(CUBE), "b.stl": binaryStl(CUBE) }), "lim.zip", { maxObjects: 1 });
const damaged = zip({ "a.stl": binaryStl(CUBE) }, 0);
damaged[40] ^= 0xff;
add("zip/crc-mismatch", damaged, "crc.zip");
add("zip/truncated", zip({ "a.stl": binaryStl(CUBE) }).subarray(0, 60), "trunc.zip");
add("zip/companion-case-insensitive", zip({ "Model.OBJ": utf8(`mtllib PAINT.mtl\n${objCube()}`.replace("\nf 1 3 2", "\nusemtl Green\nf 1 3 2")), "sub/paint.MTL": mtl }), "case.zip");

// ---- Real models shipped in this repository ----------------------------------
const real = [
  "testdata/parity/geometry/tetrahedron.obj",
  "testdata/parity/geometry/tetrahedron.stl",
  "testdata/parity/geometry/tetrahedron.step",
  "web/public/models/cube_20mm.stl",
  "web/public/models/3dbenchy.stl",
  "web/public/calibration/OrcaToleranceTest.stl",
];
for (const path of real) {
  const bytes = new Uint8Array(readFileSync(new URL(path, root)));
  const filename = path.split("/").pop();
  cases.push({ name: `real/${path}`, filename, path, sha256: sha256(bytes), expected: expectation(bytes, filename) });
}

const names = new Set(cases.map((c) => c.name));
assert.equal(names.size, cases.length, "case names are unique");
const accepted = cases.filter((c) => c.expected.ok).length;
const sources = [
  "web/src/project/import/formats/index.ts",
  "web/src/project/import/formats/detect.ts",
  "web/src/project/import/formats/types.ts",
  "web/src/project/import/formats/mesh.ts",
  "web/src/project/import/formats/stl.ts",
  "web/src/project/import/formats/obj.ts",
  "web/src/project/import/formats/xml.ts",
  "web/src/project/import/formats/amf.ts",
  "web/src/project/serialization/deterministicZip.ts",
  ...real,
].map((path) => ({ path, sha256: sha256(readFileSync(new URL(path, root))) }));
const header = JSON.stringify({ format: 1, sources });
// One compact case per line keeps the corpus reviewable as line diffs.
const output = `${header.slice(0, -1)},"cases":[\n${cases.map((row) => JSON.stringify(row)).join(",\n")}\n]}\n`;
const target = new URL("testdata/cross-platform/model-import-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(target, output);
else assert.equal(readFileSync(target, "utf8"), output, "model import references are stale; rerun with --write");
console.log(JSON.stringify({ cases: cases.length, accepted, refused: cases.length - accepted }));
