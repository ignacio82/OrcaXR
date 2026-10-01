import assert from 'node:assert/strict';
import { renderXrUnsavedProjectDialog } from '../XrUnsavedProjectDialog';
import { createFakeXrUi, FakePanel } from './fakeXrUi';
const ui = createFakeXrUi();
const root = new FakePanel({});
const choices: string[] = [];
renderXrUnsavedProjectDialog(ui, root, 'Example', (choice) => choices.push(choice));
for (const label of ['Save and continue', 'Discard and continue', 'Cancel']) {
  assert.ok(root.findButton(label), label);
  root.findButton(label)!.click();
}
assert.deepEqual(choices, ['save', 'discard', 'cancel']);
assert.ok(root.labels().some((label) => label.includes('Example')));
assert.ok(root.labels().some((label) => label.includes('handoff')));
console.log('XR unsaved project dialog shares all three decisions and download limits.');
