import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { CORE_BROWSER_ASSET } from '../../core/browser/asset';

/** Emit preview and archive workers as entries in the application graph. Vite's
 * separate worker graph duplicates codecs and contract helpers already used by
 * the host. Strict entry signatures keep each context's startup code in its own
 * entry; pure shared modules become chunks. Worker instances remain independent. */
export function sharedPreviewWorker(): Plugin {
  let root: string;
  let entry: string | undefined;
  let archiveEntry: string | undefined;
  return {
    name: 'orcaxr-shared-preview-worker',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
    },
    transform(code, id) {
      const archiveHosts = [
        ['src/import/BbsProjectImportWorkerClient.ts', '../project/serialization/projectArchive.worker.ts'],
        ['src/project/serialization/WorkerProjectSerializer.ts', './projectArchive.worker.ts'],
      ];
      for (const [host, relative] of archiveHosts) {
        if (id !== resolve(root, host)) continue;
        const anchor = `new URL('${relative}', import.meta.url)`;
        if (code.split(anchor).length !== 2)
          this.error('Archive worker entry binding changed; update its shared build contract.');
        archiveEntry ??= this.emitFile({
          type: 'chunk',
          id: resolve(root, 'src/project/serialization/projectArchive.worker.ts'),
          name: 'projectArchive.worker',
          preserveSignature: 'strict',
        });
        return { code: code.replace(anchor, `import.meta.ROLLUP_FILE_URL_${archiveEntry}`), map: null };
      }
      if (id !== resolve(root, 'src/slicer/WorkerGcodePreviewSession.ts')) return;
      const anchor = "new URL('./gcodePreview.worker.ts', import.meta.url)";
      if (code.split(anchor).length !== 2)
        this.error('Preview worker entry binding changed; update its shared build contract.');
      entry ??= this.emitFile({
        type: 'chunk',
        id: resolve(root, 'src/slicer/gcodePreview.worker.ts'),
        name: 'gcodePreview.worker',
        preserveSignature: 'strict',
      });
      return { code: code.replace(anchor, `import.meta.ROLLUP_FILE_URL_${entry}`), map: null };
    },
    generateBundle(_options, bundle) {
      if (!entry) this.error('Preview worker entry was not emitted');
      if (!archiveEntry) this.error('Archive worker entry was not emitted');
      const assets = new Set<string>();
      const visit = (name: string) => {
        if (assets.has(name)) return;
        const chunk = bundle[name];
        if (!chunk || chunk.type !== 'chunk') this.error('Missing preview dependency: ' + name);
        assets.add(name);
        for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) visit(dependency);
      };
      visit(this.getFileName(entry));
      visit(this.getFileName(archiveEntry));
      const host = Object.values(bundle).find(
        (chunk) => chunk.type === 'chunk' && resolve(root, 'src/slicer/WorkerGcodePreviewSession.ts') in chunk.modules,
      );
      if (!host) this.error('Preview host entry was not emitted');
      visit(host.fileName);
      assets.add(CORE_BROWSER_ASSET.manifest.path);
      assets.add(CORE_BROWSER_ASSET.wasm.path);
      this.emitFile({
        type: 'asset',
        fileName: 'core-preview-assets.json',
        source:
          JSON.stringify({
            schemaVersion: 1,
            workerProtocol: 2,
            coreSet: CORE_BROWSER_ASSET.setId,
            assets: [...assets].sort(),
          }) + '\n',
      });
    },
  };
}
