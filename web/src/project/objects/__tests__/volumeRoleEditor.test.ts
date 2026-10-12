import assert from 'node:assert/strict';

import { createProjectFixture } from '../../__tests__/fixtures';
import { cloneJson } from '../../domain/canonical';
import { entityId, type VolumeId } from '../../domain/ids';
import { emptyFacetAnnotations, type ProjectState, type ProjectVolume, type VolumeRole } from '../../domain/model';
import {
  volumeRoleBlockReason,
  volumeRoleEditorProjection,
  volumeRoleLabel,
  volumeRoleOperationMessages,
  volumeRoleSummary,
} from '../volumeRoleEditor';
import {
  volumeRoleDecisionExchange,
  volumeRoleEditorExchange,
  volumeRoleMessagesExchange,
} from '../volumeRoleEditorExchange';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function withVolume(state: ProjectState, id: VolumeId, role: VolumeRole, name: string): ProjectVolume {
  const object = state.plates[0].objects[0];
  const volume = cloneJson(object.volumes[0]);
  volume.id = id;
  volume.name = name;
  volume.role = role;
  volume.annotations = emptyFacetAnnotations(volume.source.topologyRevision);
  delete volume.filamentId;
  object.volumes.push(volume);
  return volume;
}

const fixture = createProjectFixture();
const modifierId = entityId<'volume'>('import:test:roles-modifier');

test('every role in Orca order, the current one marked and each refusal in the command words', () => {
  const state = cloneJson(fixture.state);
  state.plates[0].objects[0].volumes[0].annotations = emptyFacetAnnotations(0);
  const modifier = withVolume(state, modifierId, 'parameter-modifier', 'Brim helper');
  modifier.filamentId = state.filaments.physical[1].id;
  const projection = volumeRoleEditorProjection(state, modifierId);
  assert.ok(projection);
  assert.equal(projection.summary, 'Brim helper — Parameter modifier');
  assert.equal(projection.objectId, state.plates[0].objects[0].id);
  assert.deepEqual(
    projection.choices.map((choice) => [choice.role, choice.label, choice.current, choice.blockedReason]),
    [
      ['model', 'Part', false, undefined],
      [
        'negative-volume',
        'Negative volume',
        false,
        'Clear the local filament assignment before converting this volume to negative-volume',
      ],
      ['parameter-modifier', 'Parameter modifier', true, 'This is the current role; no conversion is needed.'],
      [
        'support-blocker',
        'Support blocker',
        false,
        'Clear the local filament assignment before converting this volume to support-blocker',
      ],
      [
        'support-enforcer',
        'Support enforcer',
        false,
        'Clear the local filament assignment before converting this volume to support-enforcer',
      ],
    ],
  );
  // The object's only part cannot leave the model role.
  const part = volumeRoleEditorProjection(state, fixture.ids.volume);
  assert.equal(
    part?.choices[1].blockedReason,
    'The last model part on an object cannot be converted to a non-model role',
  );
  assert.equal(volumeRoleEditorProjection(state, entityId<'volume'>('import:test:missing')), undefined);
});

test('the editor names roles, conversions and blocked choices as the browser always has', () => {
  assert.equal(volumeRoleLabel('negative-volume'), 'Negative volume');
  assert.equal(volumeRoleSummary('', 'model'), ' — Part');
  assert.deepEqual(volumeRoleOperationMessages('Cube', 'support-blocker'), {
    pending: 'Converting Cube to Support blocker…',
    success: 'Converted Cube to Support blocker.',
  });
  assert.equal(volumeRoleBlockReason(undefined, false, 0), 'A unique canonical conversion decision was not provided.');
  assert.equal(
    volumeRoleBlockReason({ allowed: true, noop: false }, false, 2),
    'A unique canonical conversion decision was not provided.',
  );
  assert.equal(
    volumeRoleBlockReason({ allowed: true, noop: true }, false, 1),
    'This is the current role; no conversion is needed.',
  );
  assert.equal(volumeRoleBlockReason({ allowed: true, noop: false }, false, 1), undefined);
});

test('hosts read the same answers as canonical JSON, and malformed requests are refused', () => {
  const state = cloneJson(fixture.state);
  withVolume(state, modifierId, 'parameter-modifier', 'Brim helper');
  assert.equal(
    volumeRoleDecisionExchange(state, JSON.stringify({ volumeId: modifierId, role: 'auxiliary-volume' })),
    '{"allowed":false,"code":"unsupported-role","reason":"Volume role \\"auxiliary-volume\\" is not supported by Snapmaker Orca v2.3.4"}',
  );
  assert.equal(
    volumeRoleDecisionExchange(state, JSON.stringify({ volumeId: modifierId, role: 'model' })),
    '{"allowed":true,"noop":false}',
  );
  assert.equal(
    volumeRoleEditorExchange(state, JSON.stringify({ volumeId: 'import:test:missing' })),
    '{"projection":null}',
  );
  assert.match(volumeRoleEditorExchange(state, JSON.stringify({ volumeId: modifierId })), /"summary":"Brim helper — /);
  assert.equal(
    volumeRoleMessagesExchange(JSON.stringify({ role: 'model', volumeName: 'Cube' })),
    '{"pending":"Converting Cube to Part…","success":"Converted Cube to Part."}',
  );
  for (const request of ['', '[]', '{"volumeId":3}', '{"volumeId":"x","extra":1}', '{"role":"model"}'])
    assert.throws(() => volumeRoleEditorExchange(state, request), /invalid_request/);
  assert.throws(() => volumeRoleDecisionExchange(state, '{"volumeId":"x"}'), /invalid_request/);
  assert.throws(() => volumeRoleMessagesExchange('{"role":"auxiliary-volume","volumeName":"x"}'), /invalid_request/);
});

console.log(`volume role editor: ${passed} passed`);
