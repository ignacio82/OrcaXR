import assert from "node:assert/strict";

/** Delay only the first real /engine proof, after its bytes arrive from Express. */
export async function installDiscoveryDelay(page) {
  await page.evaluateOnNewDocument(() => {
    const original = globalThis.fetch;
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    globalThis.__discoveryTest = { release, requests: 0, held: false };
    globalThis.fetch = async (...args) => {
      const input = args[0];
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      const response = await original(...args);
      if (url.pathname !== "/engine") return response;
      globalThis.__discoveryTest.requests++;
      if (sessionStorage.getItem("discovery-delay-used")) return response;
      sessionStorage.setItem("discovery-delay-used", "true");
      const payload = await response.json();
      response.json = async () => {
        await held;
        return payload;
      };
      globalThis.__discoveryTest.held = true;
      return response;
    };
  });
}

export async function exerciseDiscovery(page, url) {
  await page.waitForFunction(() => globalThis.__discoveryTest.held, {
    timeout: 10_000,
  });
  const pending = await page.evaluate(() => ({
    enabled: document.querySelector("#external-slicer-enabled").checked,
    atomic: localStorage.getItem("orcaxr.slicer.connection"),
    legacyEnabled: localStorage.getItem("orcaxr.slicer.enabled"),
  }));
  assert.equal(
    pending.enabled,
    false,
    "unverified discovery must not activate a route",
  );
  assert.equal(
    pending.atomic,
    null,
    "discovery must not publish candidate preferences",
  );
  assert.notEqual(pending.legacyEnabled, "true");
  await page.evaluate((endpoint) => {
    const input = document.querySelector("#external-slicer-url");
    input.value = endpoint;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#btn-external-slicer-connect").click();
  }, url);
  await page.waitForFunction(
    () =>
      /Online.*attested/.test(
        document.querySelector("#external-slicer-status").textContent,
      ),
    { timeout: 10_000 },
  );
  await page.evaluate(async () => {
    globalThis.__discoveryTest.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(
    await page.$eval("#external-slicer-status", (node) => node.textContent),
    /Online.*attested/,
  );
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("orcaxr.slicer.connection")).origin,
    ),
    "user",
  );

  // Begin a fresh auto-discovered choice, then disable and reload it.
  await page.evaluate(() =>
    localStorage.removeItem("orcaxr.slicer.connection"),
  );
  await page.reload({ waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForFunction(
    () =>
      /Slicing here.*attested/.test(
        document.querySelector("#external-slicer-status").textContent,
      ),
    { timeout: 10_000 },
  );
  await page.evaluate(() => {
    const checkbox = document.querySelector("#external-slicer-enabled");
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.reload({ waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForSelector("#app-boot.ready", { timeout: 60_000 });
  await page.waitForFunction(
    () =>
      document.querySelector("#external-slicer-status").textContent ===
      "Offline",
    { timeout: 10_000 },
  );
  assert.equal(
    await page.evaluate(() => globalThis.__discoveryTest.requests),
    0,
    "disabled startup must not probe its saved server",
  );
  assert.equal(
    await page.$eval("#external-slicer-enabled", (node) => node.checked),
    false,
  );

  // Restore the ordinary automatic connection for the rest of the deployment suite.
  await page.evaluate(() =>
    localStorage.removeItem("orcaxr.slicer.connection"),
  );
  await page.reload({ waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForSelector("#app-boot.ready", { timeout: 60_000 });
  await page.waitForFunction(
    () =>
      /Slicing here.*attested/.test(
        document.querySelector("#external-slicer-status").textContent,
      ),
    { timeout: 10_000 },
  );
  // A browser may expose the storage property but reject access to it entirely.
  // The live app must still boot and connect, with an honest persistence hint.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Browser storage is blocked", "SecurityError");
      },
    });
  });
  await page.reload({ waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForSelector("#app-boot.ready", { timeout: 60_000 });
  await page.waitForFunction(
    () =>
      /only saved for this tab/.test(
        document.querySelector("#external-slicer-hint").textContent,
      ) && document.querySelector("#external-slicer-enabled").checked,
    { timeout: 10_000 },
  );
}
