// Actual browser module worker without a test HTTP listener. This qualifies the
// WASM boundary/worker lifetime, not production network/cache/offline startup.
// The page is an intercepted secure origin: Chrome refuses blob module workers
// from an opaque about:blank origin, and WebCrypto needs a secure context.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../web/package.json", import.meta.url),
);
const puppeteer = require("puppeteer");
const root = new URL("../../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");
const [
  glue,
  replay,
  boundaries,
  fixtureText,
  layoutText,
  modelText,
  timestampsText,
  queryReplay,
  queryFixtureText,
  queryLayoutText,
  stagedReplay,
  stagedBoundaries,
  clipboardBoundaries,
  documentReplay,
  documentFixtureText,
  stagedFixtureText,
  stagingLayoutText,
  archiveReplay,
  archiveLayoutText,
  canonicalArchivesText,
  foreignArchivesText,
  wasm,
] = await Promise.all([
  read("core/dist/project-wasm/orcaxr_core.js"),
  read("tools/cross-platform/project-wasm-replay.mjs"),
  read("tools/cross-platform/project-wasm-boundaries.mjs"),
  read("testdata/cross-platform/project-session-vectors.json"),
  read("contracts/project-host.json"),
  read("testdata/cross-platform/project-model-vectors.json"),
  read("testdata/cross-platform/validation-value-vectors.json"),
  read("tools/cross-platform/project-query-replay.mjs"),
  read("testdata/cross-platform/project-query-vectors.json"),
  read("contracts/project-query.json"),
  read("tools/cross-platform/project-staged-replay.mjs"),
  read("tools/cross-platform/project-staged-boundaries.mjs"),
  read("tools/cross-platform/project-clipboard-boundaries.mjs"),
  read("tools/cross-platform/project-document-replay.mjs"),
  read("testdata/cross-platform/project-document-vectors.json"),
  read("testdata/cross-platform/project-staged-session-vectors.json"),
  read("contracts/project-staging.json"),
  read("tools/cross-platform/archive-wasm-replay.mjs"),
  read("contracts/project-archive.json"),
  read("testdata/cross-platform/canonical-complete-vectors.json"),
  read("testdata/cross-platform/foreign-import-vectors.json"),
  readFile(new URL("core/dist/project-wasm/orcaxr_core_bg.wasm", root)),
]);
// Real archives referenced by the foreign corpus, delivered as bytes.
const archiveFiles = Object.fromEntries(
  await Promise.all(
    [
      ...new Set(
        JSON.parse(foreignArchivesText)
          .cases.map((c) => c.archivePath)
          .filter(Boolean),
      ),
    ].map(async (path) => [
      path,
      (await readFile(new URL(path, root))).toString("base64"),
    ]),
  ),
);
const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  dumpio: process.env.ORCAXR_BROWSER_DIAGNOSTICS === "1",
  timeout: 30_000,
  protocolTimeout: 1_200_000,
  args: [
    "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
    "--use-angle=swiftshader",
  ],
});
try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (request) =>
    request.respond({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>project-wasm</title>",
    }),
  );
  await page.goto("https://project-wasm.invalid/");
  const result = await page.evaluate(
    async ({
      glue,
      replay,
      boundaries,
      fixture,
      layout,
      base,
      timestamps,
      queryReplay,
      queryFixture,
      queryLayout,
      stagedReplay,
      stagedBoundaries,
      clipboardBoundaries,
      documentReplay,
      documentFixture,
      stagedFixture,
      stagingLayout,
      archiveReplay,
      archiveLayout,
      canonicalArchives,
      foreignArchives,
      archiveFiles,
      wasm,
    }) => {
      const coreUrl = URL.createObjectURL(
        new Blob([glue], { type: "text/javascript" }),
      );
      const workerUrl = URL.createObjectURL(
        new Blob(
          [
            `import * as core from '${coreUrl}';\n${replay}\n${boundaries}\n${queryReplay}\n${stagedReplay}\n${stagedBoundaries}\n${clipboardBoundaries}\n${documentReplay}\n${archiveReplay}\nconst b64=(t)=>Uint8Array.from(atob(t),(c)=>c.charCodeAt(0));const sha256=async(b)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",b)),(x)=>x.toString(16).padStart(2,"0")).join("");self.onmessage=async({data})=>{try{await core.default({module_or_path:data.wasm});const result=await replayProject(core,data.fixture,data.layout);result.archives=await replayArchives(core,data.layout,data.archiveLayout,archiveCases(JSON.parse(data.canonicalArchives),JSON.parse(data.foreignArchives),(p)=>b64(data.archiveFiles[p]),b64),sha256);Object.assign(result,replayProjectDocuments(core,data.documentFixture,data.layout),await replayStagedProject(core,data.stagedFixture,data.layout,data.stagingLayout,data.queryLayout),projectStagedBoundaries(core,data.stagedFixture.traces[0],data.layout,data.stagingLayout),projectClipboardBoundaries(core,data.stagedFixture,data.layout,data.stagingLayout,data.queryLayout),projectBoundaries(core,data.base,data.layout,data.timestamps),replayProjectQueries(core,data.queryFixture,data.queryLayout));self.postMessage({ok:true,result},[result.owned.buffer,result.ownedQueryText.buffer]);}catch(e){self.postMessage({ok:false,error:String(e)});}};`,
          ],
          { type: "text/javascript" },
        ),
      );
      const worker = new Worker(workerUrl, { type: "module" });
      let timer;
      try {
        const result = await new Promise((resolve, reject) => {
          timer = setTimeout(
            () => reject(Error("Project worker deadline exceeded")),
            900_000,
          );
          worker.onerror = (e) => reject(Error(e.message));
          worker.onmessage = ({ data }) =>
            data.ok ? resolve(data.result) : reject(Error(data.error));
          const bytes = Uint8Array.from(atob(wasm), (c) => c.charCodeAt(0));
          worker.postMessage(
            {
              wasm: bytes,
              fixture,
              layout,
              base,
              timestamps,
              queryFixture,
              queryLayout,
              stagedFixture,
              documentFixture,
              stagingLayout,
              archiveLayout,
              canonicalArchives,
              foreignArchives,
              archiveFiles,
            },
            [bytes.buffer],
          );
        });
        worker.terminate();
        if (!(result.owned instanceof Uint8Array))
          throw Error("Missing owned transferred bytes");
        if (
          !(result.ownedQueryText instanceof Uint16Array) ||
          JSON.stringify(Array.from(result.ownedQueryText)) !==
            JSON.stringify(result.ownedQueryExpected)
        )
          throw Error("Invalid transferred query text");
        return {
          traces: result.traces,
          groups: result.groups,
          requests: result.requests,
          stagedTraces: result.stagedTraces,
          stagedGroups: result.stagedGroups,
          stagedRequests: result.stagedRequests,
          commandUploads: result.commandUploads,
          commandUploadRefusals: result.commandUploadRefusals,
          documentTraces: result.documentTraces,
          documentSteps: result.documentSteps,
          documentRefusals: result.documentRefusals,
          clipboardCaptures: result.clipboardCaptures,
          clipboardRefusals: result.clipboardRefusals,
          refusals: result.refusals,
          timestamps: result.timestamps,
          queryCaptures: result.queryCaptures,
          queryNodes: result.queryNodes,
          queryPages: result.queryPages,
          queryRefusals: result.queryRefusals,
          queryEngineRefusals: result.engineRefusals,
          ownedQueryTextUnits: result.ownedQueryText.length,
          archives: result.archives,
          owned: Array.from(result.owned),
          isolated: crossOriginIsolated,
        };
      } finally {
        clearTimeout(timer);
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        URL.revokeObjectURL(coreUrl);
      }
    },
    {
      glue,
      replay,
      boundaries,
      queryReplay,
      queryFixture: JSON.parse(queryFixtureText),
      queryLayout: JSON.parse(queryLayoutText),
      stagedReplay: stagedReplay.replace(/^import[\s\S]*?;\n/m, ""),
      stagedBoundaries: stagedBoundaries.replace(/^import[\s\S]*?;\n/m, ""),
      clipboardBoundaries: clipboardBoundaries.replace(
        /^import[\s\S]*?;\n/m,
        "",
      ),
      documentReplay: documentReplay.replace(/^import[\s\S]*?;\n/m, ""),
      documentFixture: JSON.parse(documentFixtureText),
      stagedFixture: JSON.parse(stagedFixtureText),
      stagingLayout: JSON.parse(stagingLayoutText),
      archiveReplay,
      archiveLayout: JSON.parse(archiveLayoutText),
      canonicalArchives: canonicalArchivesText,
      foreignArchives: foreignArchivesText,
      archiveFiles,
      fixture: JSON.parse(fixtureText),
      layout: JSON.parse(layoutText),
      base: JSON.parse(JSON.parse(modelText).factories[0].stateJson),
      timestamps: JSON.parse(timestampsText).timestamps,
      wasm: wasm.toString("base64"),
    },
  );
  assert.equal(result.isolated, false);
  assert.deepEqual(
    [result.archives.cases, result.archives.accepted, result.archives.saves],
    [1341, 1225, 1223],
  );
  assert.deepEqual(
    result.owned,
    JSON.parse(fixtureText).traces.at(-1).asset.bytes,
  );
  const report = {
    ...result,
    owned: undefined,
    ownedBytes: result.owned.length,
    browser: await browser.version(),
  };
  await mkdir(new URL("tools/cross-platform/results/", root), {
    recursive: true,
  });
  await writeFile(
    new URL("tools/cross-platform/results/project-wasm-browser.json", root),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
