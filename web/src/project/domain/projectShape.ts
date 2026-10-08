import {
  PROJECT_SHAPE_BOOL_LITERALS,
  PROJECT_SHAPE_ENTITY_IDS,
  PROJECT_SHAPE_NUMBER_ENUMS,
  PROJECT_SHAPE_RECORDS,
  PROJECT_SHAPE_TEXT_ENUMS,
} from '../../../../contracts/generated/project-shape';
import { isStableEntityId } from './ids';

/**
 * Schema-1 structure, exactly as the native core decodes a candidate state
 * (`ProjectState::from_value`): every record field its declared type, required
 * unless optional, and present optional fields never null; unknown fields kept
 * but finite. The record table is generated from the core's own declarations
 * (`generate-project-shape.mjs`), so the two refuse the same states. Graph
 * semantics (references, topology, timestamps) stay with `assertValidProjectState`.
 */
export function assertProjectShape(state: unknown): void {
  checker('ProjectState')(state, []);
}

type Path = (string | number)[];
type Check = (value: unknown, path: Path) => void;

const ENTITY_IDS = new Set(PROJECT_SHAPE_ENTITY_IDS);
const checks = new Map<string, Check>();

function checker(type: string): Check {
  let check = checks.get(type);
  if (check === undefined) {
    check = compile(type);
    checks.set(type, check);
  }
  return check;
}

function compile(type: string): Check {
  const generic = /^(\w+)<(.+)>$/.exec(type);
  if (generic) {
    const [, outer, inner] = generic;
    // Optionality is a record field's business: a present value is the inner type.
    if (outer === 'Option' || outer === 'Arc') return (value, path) => checker(inner)(value, path);
    if (outer === 'List') return list(inner);
    if (outer === 'Assignments') return assignments(inner);
  }
  const tuple = /^\[(.+);(\d+)\]$/.exec(type);
  if (tuple) return list(tuple[1], Number(tuple[2]));
  switch (type) {
    case 'Text':
      return (value, path) => {
        if (typeof value !== 'string') fail(path, 'expected text');
      };
    case 'Number':
      return number;
    case 'bool':
      return (value, path) => {
        if (typeof value !== 'boolean') fail(path, 'expected a boolean');
      };
    case 'Vec3':
      return list('Number', 3);
    case 'Quaternion':
      return list('Number', 4);
    case 'ConfigMap':
    case 'JsonObject':
      return (value, path) => {
        if (!isObject(value)) fail(path, 'expected an object');
        finite(value, path);
      };
    case 'Json':
      return finite;
    case 'MixedDistribution':
      return distribution;
  }
  if (ENTITY_IDS.has(type))
    return (value, path) => {
      if (typeof value !== 'string') fail(path, 'expected text');
      if (!isStableEntityId(value)) fail(path, 'expected a stable entity ID');
    };
  const text = PROJECT_SHAPE_TEXT_ENUMS[type];
  if (text)
    return (value, path) => {
      if (typeof value !== 'string') fail(path, 'expected text');
      if (!text.includes(value)) fail(path, `unsupported ${type}`);
    };
  const numbers = PROJECT_SHAPE_NUMBER_ENUMS[type];
  if (numbers)
    return (value, path) => {
      number(value, path);
      if (!numbers.includes(value as number)) fail(path, `unsupported ${type}`);
    };
  if (Object.hasOwn(PROJECT_SHAPE_BOOL_LITERALS, type)) {
    const literal = PROJECT_SHAPE_BOOL_LITERALS[type];
    return (value, path) => {
      if (typeof value !== 'boolean') fail(path, 'expected a boolean');
      if (value !== literal) fail(path, `expected ${literal}`);
    };
  }
  const fields = PROJECT_SHAPE_RECORDS[type];
  if (fields) return record(fields);
  throw new Error(`Project shape type ${type} is not supported`);
}

function record(fields: readonly (readonly [string, string])[]): Check {
  const known = new Set(fields.map(([name]) => name));
  return (value, path) => {
    if (!isObject(value)) fail(path, 'expected an object');
    for (const [name, type] of fields) {
      path.push(name);
      if (Object.hasOwn(value, name)) checker(type)(value[name], path);
      else if (!type.startsWith('Option<')) fail(path, 'missing field');
      path.pop();
    }
    for (const name of Object.keys(value)) {
      if (known.has(name)) continue;
      path.push(name);
      finite(value[name], path);
      path.pop();
    }
  };
}

function list(item: string, length?: number): Check {
  return (value, path) => {
    if (!Array.isArray(value)) fail(path, 'expected an array');
    if (length !== undefined && value.length !== length) fail(path, `expected ${length} items`);
    const check = checker(item);
    value.forEach((entry, index) => {
      path.push(index);
      check(entry, path);
      path.pop();
    });
  };
}

/** Sparse facet assignments: `{ value, triangles: number[] }` entries, kept as JSON. */
function assignments(item: string): Check {
  return (value, path) => {
    if (!Array.isArray(value)) fail(path, 'expected an array');
    const check = checker(item);
    value.forEach((entry, index) => {
      path.push(index);
      if (!isObject(entry)) fail(path, 'expected an object');
      path.push('value');
      if (!Object.hasOwn(entry, 'value')) fail(path, 'missing field');
      check(entry.value, path);
      path.pop();
      path.push('triangles');
      if (!Object.hasOwn(entry, 'triangles')) fail(path, 'missing field');
      if (!Array.isArray(entry.triangles)) fail(path, 'expected an array');
      entry.triangles.forEach((triangle, triangleIndex) => {
        if (typeof triangle !== 'number') fail([...path, triangleIndex], 'expected a number');
      });
      path.pop();
      path.pop();
    });
    finite(value, path);
  };
}

const DISTRIBUTIONS: Readonly<Record<string, string>> = {
  ratio: 'RatioDistribution',
  cycle: 'CycleDistribution',
  match: 'MatchDistribution',
  gradient: 'GradientDistribution',
};
function distribution(value: unknown, path: Path): void {
  if (!isObject(value)) fail(path, 'expected an object');
  if (!Object.hasOwn(value, 'mode')) fail([...path, 'mode'], 'missing field');
  if (typeof value.mode !== 'string') fail([...path, 'mode'], 'expected text');
  if (!Object.hasOwn(DISTRIBUTIONS, value.mode)) fail([...path, 'mode'], 'unsupported distribution mode');
  checker(DISTRIBUTIONS[value.mode])(value, path);
}

function number(value: unknown, path: Path): void {
  if (typeof value !== 'number') fail(path, 'expected a number');
  if (!Number.isFinite(value)) fail(path, 'expected a finite number');
}

/** Generic JSON: any value, every number finite. */
function finite(root: unknown, path: Path): void {
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail(path, 'expected finite numbers');
    } else if (Array.isArray(value)) {
      for (const child of value) stack.push(child);
    } else if (isObject(value)) {
      for (const key of Object.keys(value)) stack.push(value[key]);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: Path, message: string): never {
  const at = path.map((step, index) => (typeof step === 'number' ? `[${step}]` : index === 0 ? step : `.${step}`));
  throw new Error(`Invalid project state at ${at.join('') || 'the root'}: ${message}`);
}
