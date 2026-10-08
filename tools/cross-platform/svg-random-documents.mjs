// Seeded random SVG documents for the reader corpus: every construct the
// reader handles, combined with the malformed and unusual spellings real
// files and hostile ones carry.
export function randomSvgs(count, seed = 0x5eed5eedn) {
  let state = seed;
  const next = () => {
    state ^= state >> 12n;
    state ^= (state << 25n) & 0xffffffffffffffffn;
    state ^= state >> 27n;
    return (state * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
  };
  const unit = () => Number(next() >> 11n) / 2 ** 53;
  const int = (n) => Math.floor(unit() * n);
  const pick = (list) => list[int(list.length)];
  const chance = (p) => unit() < p;
  const num = () => {
    const forms = [
      () => String(int(200)),
      () => (unit() * 200 - 100).toFixed(int(4)),
      () => `.${int(100)}`,
      () => `-.${int(100)}`,
      () => `${int(9)}e${int(3)}`,
      () => `${int(50)}.`,
      () => `+${int(50)}`,
      () => `${int(9)}.${int(9)}.${int(9)}`,
      () => `${int(5)}E-${int(2)}`,
      () => "0",
      () => "-0",
      () => `${int(9)}e400`,
    ];
    return pick(forms)();
  };
  const sep = () => pick([" ", ",", " , ", "\n", "\t", "", "  ", "　"]);
  const color = () =>
    pick([
      "none",
      "NONE",
      " none",
      "#000",
      "red",
      "currentColor",
      "url(#g)",
      "transparent",
      "None !important",
      "#f00!important",
    ]);
  const length = () =>
    pick([
      () =>
        `${num()}${pick(["", "px", "mm", "cm", "in", "pt", "pc", "q", "Q", "MM", "%", "em", "ex", "vw", "constructor"])}`,
      () => ` ${int(100)} mm `,
      () => `${int(100)}e1mm`,
      () => "",
      () => "auto",
      () => `${int(100)} mm`,
    ])();
  const transform = () => {
    const one = () =>
      pick([
        () => `translate(${num()}${sep()}${num()})`,
        () => `translate(${num()})`,
        () => `scale(${num()})`,
        () => `scale(${num()} ${num()})`,
        () => `rotate(${num()})`,
        () => `rotate(${num()} ${num()} ${num()})`,
        () => `skewX(${num()})`,
        () => `skewY(${num()})`,
        () => `matrix(${Array.from({ length: 6 }, num).join(sep())})`,
        () => `matrix(${num()} ${num()})`,
        () => `SCALE (${num()})`,
        () => `perspective(${num()})`,
        () => `rotate(${num()}`,
        () => `translate${num()}`,
      ])();
    return Array.from({ length: 1 + int(3) }, one).join(
      pick([" ", ",", "", "\n"]),
    );
  };
  const pathData = () => {
    const commands = [];
    const n = 2 + int(10);
    if (chance(0.9)) commands.push(`${pick(["M", "m"])}${num()} ${num()}`);
    for (let i = 0; i < n; i++) {
      const c = pick([
        "L",
        "l",
        "H",
        "h",
        "V",
        "v",
        "C",
        "c",
        "S",
        "s",
        "Q",
        "q",
        "T",
        "t",
        "A",
        "a",
        "Z",
        "z",
        "M",
        "m",
      ]);
      const arity = {
        M: 2,
        L: 2,
        H: 1,
        V: 1,
        C: 6,
        S: 4,
        Q: 4,
        T: 2,
        A: 7,
        Z: 0,
      }[c.toUpperCase()];
      const groups = chance(0.2) ? 2 : 1;
      let values = [];
      for (let g = 0; g < groups; g++) {
        for (let k = 0; k < arity; k++) {
          if (c.toUpperCase() === "A" && (k === 3 || k === 4))
            values.push(pick(["0", "1", "0", "1", "2"]));
          else if (c.toUpperCase() === "A" && k < 2)
            values.push(chance(0.1) ? "0" : String(1 + int(60)));
          else values.push(num());
        }
      }
      if (chance(0.1)) values = values.slice(0, Math.max(0, values.length - 1));
      commands.push(c + values.join(pick([" ", ",", ""])));
    }
    if (chance(0.7)) commands.push(pick(["Z", "z"]));
    return commands.join(pick(["", " ", "\n"]));
  };
  const presentation = () => {
    const parts = [];
    if (chance(0.3)) parts.push(` fill="${color()}"`);
    if (chance(0.3)) parts.push(` stroke="${color()}"`);
    if (chance(0.25))
      parts.push(
        ` style="${Array.from({ length: 1 + int(3) }, () => `${pick(["fill", "FILL", "stroke", "stroke-width", "fill-opacity"])}${pick([":", " : "])}${color()}`).join(pick([";", "; ", ";;"]))}"`,
      );
    if (chance(0.3))
      parts.push(
        ` class="${Array.from({ length: 1 + int(2) }, () => pick(["a", "b", "line", "solid", "c-1"])).join(pick([" ", "　", "\t"]))}"`,
      );
    if (chance(0.15)) parts.push(` id="${pick(["p", "q", "main"])}"`);
    if (chance(0.25)) parts.push(` transform="${transform()}"`);
    return parts.join("");
  };
  const quote = (name, value) =>
    chance(0.2) ? ` ${name}='${value}'` : ` ${name}="${value}"`;
  const shape = () => {
    const tag = (name) =>
      chance(0.1) ? name.toUpperCase() : chance(0.05) ? `svg:${name}` : name;
    const close = chance(0.7) ? "/>" : ` ></${"x"}>`;
    return pick([
      () =>
        `<${tag("rect")}${quote("x", num())}${quote("y", num())}${quote("width", num())}${quote("height", num())}${chance(0.4) ? quote("rx", num()) : ""}${chance(0.3) ? quote("ry", chance(0.2) ? "" : num()) : ""}${presentation()}${close}`,
      () =>
        `<${tag("circle")}${quote("cx", num())}${quote("cy", num())}${quote("r", num())}${presentation()}/>`,
      () =>
        `<${tag("ellipse")}${quote("cx", num())}${quote("cy", num())}${quote("rx", num())}${quote("ry", num())}${presentation()}/>`,
      () =>
        `<${tag(pick(["polygon", "polyline"]))}${quote("points", Array.from({ length: 2 + int(8) }, num).join(sep()))}${presentation()}/>`,
      () =>
        `<${tag("line")}${quote("x1", num())}${quote("y1", num())}${quote("x2", num())}${quote("y2", num())}${presentation()}/>`,
      () => `<${tag("path")}${quote("d", pathData())}${presentation()}/>`,
      () => `<${tag("path")}${quote("d", pathData())}${presentation()}/>`,
      () =>
        `<${pick(["text", "tspan", "image", "use", "clipPath", "mask", "filter", "pattern", "linearGradient", "radialGradient", "marker", "textPath"])}${presentation()}>x</${"text"}>`,
      () =>
        `<${pick(["title", "desc", "metadata", "foo", "constructor", "toString", "ÄRGER", "Σ"])}${presentation()}>words</x>`,
      () => `<!-- <rect width="5" height="5"/> -->`,
      () => `<![CDATA[ <rect width="5" height="5"/> ]]>`,
      () => `<?pi data?>`,
    ])();
  };
  const group = (depth) => {
    const children = Array.from({ length: 1 + int(4) }, () =>
      depth < 3 && chance(0.25) ? group(depth + 1) : shape(),
    );
    const name = pick(["g", "g", "a", "switch", "svg", "defs", "G", "symbol"]);
    return `<${name}${presentation()}>${children.join(pick(["", "\n", " "]))}</${name}>`;
  };
  const stylesheet = () => {
    const rule = () => {
      const selector = Array.from({ length: 1 + int(2) }, () =>
        pick([
          "path",
          "rect",
          "PATH",
          ".a",
          ".b",
          ".line",
          ".solid",
          "#p",
          "#main",
          "g path",
          "*",
          "a:hover",
          ".a.b",
          "",
          "circle",
        ]),
      ).join(pick([",", ", ", " ,"]));
      const body = Array.from(
        { length: int(3) + 1 },
        () =>
          `${pick(["fill", "stroke", "Fill", "color", "stroke-width"])}${pick([":", " :", ": "])}${color()}`,
      ).join(pick([";", "; ", ";;"]));
      return pick([
        () => `${selector}{${body}}`,
        () => `${selector} { ${body} }`,
        () => `/* ${selector}{${body}} */`,
        () => `@media print { ${selector} { ${body} } }`,
        () => `@import url(x.css);`,
        () => `@font-face { font-family: x }`,
        () => `${selector} { ${body}`,
        () => `{${body}}`,
      ])();
    };
    return `<style${chance(0.3) ? ' type="text/css"' : ""}>${chance(0.2) ? "<![CDATA[" : ""}${Array.from({ length: 1 + int(4) }, rule).join("\n")}${chance(0.2) ? "]]>" : ""}</${pick(["style", "STYLE"])}>`;
  };
  const document = () => {
    const attrs = [];
    if (chance(0.7)) attrs.push(quote("width", length()));
    if (chance(0.7)) attrs.push(quote("height", length()));
    if (chance(0.7))
      attrs.push(
        quote(
          pick(["viewBox", "viewbox", "VIEWBOX"]),
          pick([
            () => `${num()} ${num()} ${int(300)} ${int(300)}`,
            () => `0,0,${int(300)},${int(300)}`,
            () => `0 0 ${int(300)}`,
            () => `0 0 -10 10`,
          ])(),
        ),
      );
    if (chance(0.2)) attrs.push(quote("transform", transform()));
    if (chance(0.3)) attrs.push(presentation());
    const body = [];
    if (chance(0.3)) body.push(stylesheet());
    for (let i = 0, n = 1 + int(5); i < n; i++)
      body.push(chance(0.35) ? group(0) : shape());
    const prolog = pick([
      "",
      '<?xml version="1.0"?>\n',
      "<!DOCTYPE svg>\n",
      "<!-- drawing -->",
      "﻿",
    ]);
    const root = pick(["svg", "svg", "SVG", "svg:svg"]);
    return `${prolog}<${root} xmlns="http://www.w3.org/2000/svg"${attrs.join("")}>${body.join(pick(["", "\n"]))}</${root}>`;
  };
  return Array.from({ length: count }, () => ({
    source: document(),
    width: chance(0.25) ? pick([20, 0.5, 120, 0, -1]) : undefined,
  }));
}
