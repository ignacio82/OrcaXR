import assert from 'node:assert/strict';

// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { entityId } from '../../../project/domain/ids';
import type { CanonicalSlicePreflightResult } from '../../../project/slicing';
import { SlicePreflightPanel, type SlicePreflightActionRequest } from '../SlicePreflightPanel';

const plateId = entityId<'plate'>('import:preflight-panel:plate');
const instanceId = entityId<'instance'>('import:preflight-panel:instance');
const filamentId = entityId<'physical-filament'>('import:preflight-panel:filament');

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test('renders stable structured evidence and only supported canonical actions', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', {
    url: 'https://example.test/',
  });
  const document = dom.window.document as Document;
  const host = document.querySelector<HTMLElement>('#host')!;
  const requests: SlicePreflightActionRequest[] = [];
  const panel = new SlicePreflightPanel(host, {
    runAction: (request) => {
      requests.push(request);
    },
  });
  panel.render(result());

  const list = host.querySelector<HTMLOListElement>('[data-slice-preflight-issues]')!;
  assert.equal(list.getAttribute('aria-label'), 'Slice preflight issues');
  const issues = list.querySelectorAll<HTMLElement>('[data-preflight-issue-id]');
  assert.equal(issues.length, 2);

  const blocking = issues[0];
  assert.equal(blocking.dataset.preflightIssueId, 'slice-preflight:instance-below-build-plate:fixture');
  assert.equal(blocking.dataset.preflightCode, 'instance-below-build-plate');
  assert.equal(blocking.dataset.preflightDetailCode, 'fixture');
  assert.equal(blocking.dataset.severity, 'error');
  assert.equal(blocking.getAttribute('role'), 'alert');
  assert.ok(blocking.getAttribute('aria-labelledby'));
  assert.ok(blocking.getAttribute('aria-describedby'));
  assert.equal(blocking.querySelector('[data-preflight-severity]')?.textContent, 'Error');
  assert.equal(
    blocking.querySelector('[data-preflight-stable-code]')?.textContent,
    'instance-below-build-plate / fixture',
  );
  assert.match(blocking.querySelector('[data-preflight-message]')?.textContent ?? '', /below the build plate/);
  assert.match(blocking.querySelector('[data-preflight-help]')?.textContent ?? '', /Drop only after review/);
  assert.equal(blocking.querySelector('[data-preflight-path]')?.textContent, 'plates.0.objects.0.instances.0');
  assert.equal(
    blocking.querySelector('[data-preflight-entity-kind="instance"]')?.textContent,
    `instance: ${instanceId}`,
  );

  const actions = [...host.querySelectorAll<HTMLButtonElement>('[data-preflight-action]')];
  assert.deepEqual(
    actions.map((button) => button.dataset.preflightAction),
    ['reveal', 'drop-to-bed'],
  );
  assert.equal(host.querySelector('[data-preflight-action="move-inside-build-volume"]'), null);
  assert.equal(host.querySelector('[data-preflight-action="choose-profile"]'), null);
  assert.equal(host.querySelector('[data-preflight-action="choose-filament"]'), null);
  assert.equal(issues[1].getAttribute('role'), 'status');
  assert.equal(issues[1].querySelector('[data-preflight-action]'), null);
  assert.equal(
    issues[1].querySelector('[data-preflight-entity-kind="filament"]')?.textContent,
    `filament: ${filamentId}`,
  );

  actions[0].click();
  actions[1].click();
  await flush();
  assert.deepEqual(
    requests.map((request) => [request.issue.code, request.action.id, request.action.entity.kind]),
    [
      ['instance-below-build-plate', 'reveal', 'instance'],
      ['instance-below-build-plate', 'drop-to-bed', 'instance'],
    ],
  );

  panel.dispose();
  assert.equal(host.childElementCount, 0);
  dom.window.close();
});

function result(): CanonicalSlicePreflightResult {
  return {
    plateId,
    canSlice: false,
    blockingCount: 1,
    printableInstanceIds: [instanceId],
    usedFilamentIds: [filamentId],
    issues: [
      {
        id: 'slice-preflight:instance-below-build-plate:fixture',
        code: 'instance-below-build-plate',
        detailCode: 'fixture',
        severity: 'error',
        message: 'The instance extends below the build plate.',
        help: 'Drop only after review of the complete model.',
        path: 'plates.0.objects.0.instances.0',
        entities: [{ kind: 'instance', id: instanceId }],
        actions: [
          { id: 'reveal', label: 'Reveal model', entity: { kind: 'instance', id: instanceId } },
          { id: 'drop-to-bed', label: 'Drop to bed', entity: { kind: 'instance', id: instanceId } },
          {
            id: 'move-inside-build-volume',
            label: 'Move inside build volume',
            entity: { kind: 'instance', id: instanceId },
          },
          { id: 'choose-profile', label: 'Choose profile' },
        ],
      },
      {
        id: 'slice-preflight:unsupported-filament-material:fixture',
        code: 'unsupported-filament-material',
        severity: 'warning',
        message: 'The filament material needs review.',
        help: 'Choose a compatible material outside this panel.',
        entities: [{ kind: 'filament', id: filamentId }],
        actions: [
          { id: 'reveal', label: 'Reveal filament', entity: { kind: 'filament', id: filamentId } },
          { id: 'choose-filament', label: 'Choose filament', entity: { kind: 'filament', id: filamentId } },
        ],
      },
    ],
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

console.log(`\n${passed} slice preflight panel tests passed.`);
