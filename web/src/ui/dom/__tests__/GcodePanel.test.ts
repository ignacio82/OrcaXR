/**
 * Traces for the G-code window (P11.2).
 *
 * Two properties carry it. Only the visible rows may exist in the DOM, because
 * rendering a whole program locks the tab on the first file anyone opens. And
 * the counts must describe the whole program rather than what is rendered — a
 * viewer that says "1,000 lines" while holding a 200,000-line file would have
 * someone inspect a program that is not the one they will print.
 */

import assert from 'node:assert/strict';
// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { GcodePanel } from '../GcodePanel';
import { GcodeDocument } from '../../../project/gcode/GcodeDocument';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function mount(document: GcodeDocument | null, title?: string) {
  const dom = new JSDOM('<!doctype html><div id="host"></div>');
  const host = dom.window.document.getElementById('host') as unknown as HTMLElement;
  const panel = new GcodePanel(host, {
    getState: () => ({ document, ...(title ? { title } : {}) }),
  });
  panel.mount();
  return { host, panel };
}

const program = (lines: number): GcodeDocument =>
  new GcodeDocument(Array.from({ length: lines }, (_, index) => `G1 X${index} E0.01`).join('\n'));

await test('nothing sliced yet says so, rather than showing an empty listing', () => {
  const view = mount(null);
  assert.ok(view.host.querySelector('[data-gcode-empty]'));
  assert.match(view.host.textContent ?? '', /Slice a project/);
});

await test('only the visible rows exist in the DOM', () => {
  // The property the whole panel is built around. jsdom reports a zero client
  // height, so this is the overscan window — the point is that it is a window
  // at all and not fifty thousand rows.
  const view = mount(program(50_000));
  const rows = view.host.querySelectorAll('[data-gcode-line]');
  assert.ok(rows.length > 0, 'something is rendered');
  assert.ok(rows.length < 500, `a window, not the whole program (${rows.length} rows)`);
});

await test('the reported size is the whole program, not the window', () => {
  const view = mount(program(50_000));
  const status = view.host.querySelector('[data-gcode-status]');
  assert.match(status?.textContent ?? '', /50,000 lines/);
});

await test('a search reports how many lines matched', () => {
  const view = mount(new GcodeDocument(['G28', 'M104 S230', 'G1 X1', 'M104 S225'].join('\n')));
  const search = view.host.querySelector<HTMLInputElement>('[data-gcode-search]')!;
  search.value = 'M104';
  search.dispatchEvent(new (search.ownerDocument.defaultView as Window & typeof globalThis).Event('input'));
  assert.match(view.host.querySelector('[data-gcode-status]')?.textContent ?? '', /2 lines match/);
});

await test('a capped search says "at least", so nobody stops looking', () => {
  // 600 matching lines against a 500 cap. Reporting a bare 500 would read as
  // the total.
  const view = mount(program(600));
  const search = view.host.querySelector<HTMLInputElement>('[data-gcode-search]')!;
  search.value = 'G1';
  search.dispatchEvent(new (search.ownerDocument.defaultView as Window & typeof globalThis).Event('input'));
  assert.match(view.host.querySelector('[data-gcode-status]')?.textContent ?? '', /at least 500 lines match/);
});

await test('a line is inserted as text, never as markup', () => {
  // A program is untrusted input and a comment can carry anything.
  const hostile = new GcodeDocument('; <img src=x onerror="alert(1)">\nG28');
  const view = mount(hostile);
  assert.equal(view.host.querySelector('img'), null, 'no element came from the program');
  assert.match(view.host.textContent ?? '', /<img src=x/, 'and the text is shown as written');
});

await test('next match is inert until there is one', () => {
  const view = mount(program(10));
  const next = view.host.querySelector<HTMLButtonElement>('[data-gcode-action="next-match"]');
  assert.equal(next?.disabled, true);
});

console.log(`\nG-code panel: ${passed} tests passed.`);
