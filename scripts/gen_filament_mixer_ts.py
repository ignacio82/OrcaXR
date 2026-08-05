#!/usr/bin/env python3
"""Regenerate web/src/project/filaments/filamentMixerModel.ts from the C++ header.

The web app's mixed-filament display colors must match libslic3r's
filament_mixer pigment model exactly; this extracts the polynomial
coefficient tables so the TS port stays in lockstep with
third_party/SnapmakerOrca/src/libslic3r/filament_mixer_model.h.
Run from the repo root: python3 scripts/gen_filament_mixer_ts.py
"""
import re

src = open('third_party/SnapmakerOrca/src/libslic3r/filament_mixer_model.h').read()


def extract_array(name):
    m = re.search(rf'{name}\[[\]\[0-9]*\]\s*=\s*\{{(.*?)\n\}};', src, re.S)
    assert m, name
    rows = re.findall(r'\{([^{}]*)\}', m.group(1))
    return [[x.strip() for x in r.split(',')] for r in rows]


powers = extract_array('POWERS')
coef = extract_array('COEF')
inter = re.search(r'INTERCEPT\[3\]\s*=\s*\{(.*?)\};', src, re.S).group(1)
inter = [x.strip() for x in inter.split(',')]
assert len(powers) == 330 and len(coef) == 330, (len(powers), len(coef))
assert all(len(r) == 7 for r in powers) and all(len(r) == 3 for r in coef)

out = [
    '/**',
    ' * filament_mixer polynomial pigment-mixing model — auto-generated from',
    ' * third_party/SnapmakerOrca/src/libslic3r/filament_mixer_model.h (MIT, (c) 2026',
    ' * Justin Hayes). Degree-4 polynomial regression approximating Mixbox.',
    ' * Regenerate with the python snippet in scripts/gen_filament_mixer_ts.py',
    ' * if the C++ header changes. Do not edit manually.',
    ' */',
    '',
    'export const N_FEATURES = 330;',
    'export const N_INPUTS = 7;',
    '',
    'export const POWERS: ReadonlyArray<number> = ['
    + ','.join(str(int(v)) for r in powers for v in r) + '];',
    '',
    'export const COEF: ReadonlyArray<number> = ['
    + ','.join(v for r in coef for v in r) + '];',
    '',
    'export const INTERCEPT: ReadonlyArray<number> = [' + ','.join(inter) + '];',
]
open('web/src/project/filaments/filamentMixerModel.ts', 'w').write('\n'.join(out) + '\n')
print('regenerated web/src/project/filaments/filamentMixerModel.ts')
