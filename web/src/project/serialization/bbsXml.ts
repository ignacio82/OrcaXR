export function xmlAttribute(value: string): string {
  assertXmlValue(value, 'XML attribute');
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;');
}

export function xmlText(value: string): string {
  assertXmlValue(value, 'XML text');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function assertXmlValue(value: string, label: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint < 0x20 && codePoint !== 0x9 && codePoint !== 0xa && codePoint !== 0xd) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint === 0xfffe ||
      codePoint === 0xffff
    ) {
      throw new Error(`${label} contains a character XML 1.0 cannot represent`);
    }
  }
}
