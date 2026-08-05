#!/usr/bin/env node
/* global console */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { inspectLiveCanonicalBoundaries, selfTestLiveCanonicalBoundaries } from './live-canonical-boundaries.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const protectedRoots = [path.join(root, 'src/project/domain'), path.join(root, 'src/project/history')];
const forbiddenPackages = ['three', 'three-mesh-bvh', 'xrblocks', '@pmndrs/uikit', 'lit'];
const forbiddenProjectSegments = new Set(['actions', 'features', 'mcp', 'net', 'slicer', 'ui', 'workspace']);
const browserGlobals = new Set([
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'fetch',
  'HTMLElement',
  'HTMLCanvasElement',
  'WebGLRenderingContext',
  'XRSession',
  'Worker',
  'Blob',
  'File',
  'EventSource',
  'WebSocket',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]);

const failures = [];
for (const directory of protectedRoots) {
  for (const file of walk(directory)) inspect(file);
}
failures.push(...inspectLiveCanonicalBoundaries(root), ...selfTestLiveCanonicalBoundaries());

if (failures.length > 0) {
  console.error('Architecture boundary violations:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Architecture boundaries: domain/history are platform-neutral and live project I/O is canonical.');
}

function inspect(file) {
  const sourceText = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const relative = path.relative(root, file);

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      inspectSpecifier(relative, file, node.moduleSpecifier.text, node.moduleSpecifier);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      inspectSpecifier(relative, file, node.arguments[0].text, node.arguments[0]);
    }
    if (ts.isIdentifier(node) && browserGlobals.has(node.text) && isReference(node)) {
      failures.push(`${relative}:${lineOf(source, node)} uses browser global ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function inspectSpecifier(relative, importer, specifier, node) {
  if (forbiddenPackages.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
    failures.push(`${relative}:${lineOf(node.getSourceFile(), node)} imports ${specifier}`);
    return;
  }
  if (!specifier.startsWith('.')) {
    failures.push(`${relative}:${lineOf(node.getSourceFile(), node)} imports external module ${specifier}`);
    return;
  }
  const resolved = path.normalize(path.resolve(path.dirname(importer), specifier));
  const sourceRelative = path.relative(path.join(root, 'src'), resolved);
  const segments = sourceRelative.split(path.sep);
  const forbidden = segments.find((segment) => forbiddenProjectSegments.has(segment));
  if (forbidden) {
    failures.push(`${relative}:${lineOf(node.getSourceFile(), node)} crosses into src/${forbidden} via ${specifier}`);
  }
}

function isReference(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node)
  ) {
    return false;
  }
  return true;
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function* walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(target);
    else if (entry.isFile() && target.endsWith('.ts') && !target.endsWith('.test.ts')) yield target;
  }
}
