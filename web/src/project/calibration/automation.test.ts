import assert from 'node:assert/strict';

import { CALIBRATION_WORKFLOW_IDS } from '../../features/calibrationInventory';
import {
  CALIBRATION_AUTOMATION_RULES,
  PRINTER_OBJECTS_LIST_PATH,
  RESONANCE_ACCELEROMETERS,
  assessCalibrationAutomation,
  parsePrinterObjects,
} from './automation';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const FULL_PRINTER = [
  'configfile',
  'print_stats',
  'toolhead',
  'extruder',
  'heater_bed',
  'resonance_tester',
  'adxl345 hotend',
  'gcode_move',
];

test('every workflow is classified, and only resonance testing is automatic', () => {
  assert.deepEqual(Object.keys(CALIBRATION_AUTOMATION_RULES).sort(), [...CALIBRATION_WORKFLOW_IDS].sort());
  const automatic = CALIBRATION_WORKFLOW_IDS.filter((id) => CALIBRATION_AUTOMATION_RULES[id].kind === 'automatic');
  assert.deepEqual(
    [...automatic].sort(),
    ['input-shaping-damping', 'input-shaping-frequency'],
    'ramping a parameter was never the hard part; reading the printed result is, and no printer reports that',
  );
  for (const id of CALIBRATION_WORKFLOW_IDS) {
    const rule = CALIBRATION_AUTOMATION_RULES[id];
    assert.ok(rule.why.trim().length > 20, `${id}: the classification must justify itself`);
    assert.equal(rule.kind === 'automatic', rule.command !== undefined, `${id}: automatic means a real command`);
    if (rule.kind === 'manual') {
      assert.deepEqual(rule.requiredObjects, []);
      assert.deepEqual(rule.anyOfObjects, []);
    }
  }
});

test('a manual workflow says so whatever the printer reports', () => {
  for (const objects of [undefined, [], FULL_PRINTER]) {
    const assessment = assessCalibrationAutomation('flow-pass-1', objects);
    assert.equal(assessment.kind, 'manual');
    assert.equal(assessment.available, false);
    assert.equal(assessment.command, undefined);
    assert.equal(assessment.manualFallback, true);
    assert.match(assessment.reason, /read from the printed part/);
  }
});

test('resonance testing is offered only when the printer has the parts', () => {
  const ready = assessCalibrationAutomation('input-shaping-frequency', FULL_PRINTER);
  assert.equal(ready.kind, 'automatic');
  assert.equal(ready.available, true);
  assert.equal(ready.command, 'SHAPER_CALIBRATE');
  assert.deepEqual(ready.missing, []);
  assert.match(ready.reason, /measured by the machine rather than by eye/);

  // The accelerometer is named per Klipper convention as "<kind> <name>"; the
  // kind is what identifies the part.
  for (const accelerometer of RESONANCE_ACCELEROMETERS) {
    const assessment = assessCalibrationAutomation('input-shaping-damping', [
      'resonance_tester',
      `${accelerometer} bed`,
    ]);
    assert.equal(assessment.available, true, `${accelerometer} should qualify`);
  }
});

test('a printer without an accelerometer is told what it is missing, not refused', () => {
  const assessment = assessCalibrationAutomation('input-shaping-frequency', ['configfile', 'toolhead', 'extruder']);
  assert.equal(assessment.kind, 'automatic', 'the workflow is still one a machine can measure');
  assert.equal(assessment.available, false, 'just not this machine');
  assert.deepEqual(assessment.missing, ['resonance_tester', RESONANCE_ACCELEROMETERS.join(' or ')]);
  assert.match(assessment.reason, /reports no resonance_tester, adxl345 or lis2dw/);
  assert.match(assessment.reason, /printed test still applies/);
  assert.equal(assessment.manualFallback, true);

  const halfEquipped = assessCalibrationAutomation('input-shaping-frequency', ['resonance_tester']);
  assert.deepEqual(halfEquipped.missing, [RESONANCE_ACCELEROMETERS.join(' or ')]);
});

test('an unasked printer is unknown rather than assumed to lack the parts', () => {
  const assessment = assessCalibrationAutomation('input-shaping-frequency', undefined);
  assert.equal(assessment.available, false);
  assert.deepEqual(assessment.missing, [], 'nothing is reported missing, because nothing was asked');
  assert.match(assessment.reason, /Connect the printer to find out/);
});

test('the object list is read from Klipper’s own response shape', () => {
  assert.equal(PRINTER_OBJECTS_LIST_PATH, '/printer/objects/list');
  assert.deepEqual(parsePrinterObjects({ result: { objects: ['toolhead', 'adxl345'] } }), ['toolhead', 'adxl345']);
  assert.deepEqual(parsePrinterObjects({ objects: ['toolhead'] }), ['toolhead'], 'an unwrapped result also reads');
  assert.deepEqual(parsePrinterObjects({ result: { objects: ['ok', 7, null] } }), ['ok'], 'non-strings are dropped');
  for (const bad of [null, undefined, 42, 'objects', { result: {} }, { result: { objects: 'toolhead' } }]) {
    assert.equal(parsePrinterObjects(bad), undefined, JSON.stringify(bad));
  }
});

console.log(`\nCalibration automation: ${passed} tests passed.`);
