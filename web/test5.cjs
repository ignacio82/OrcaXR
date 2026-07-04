const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => {
    if(msg.text().includes('CATALOG LOG')) console.log(msg.text());
  });
  await page.route('**/ProfileLoader.ts*', async route => {
    const response = await page.request.fetch(route.request());
    let body = await response.text();
    body = body.replace('if (!catalog) return;', 'console.log("CATALOG LOG:", catalog ? Object.keys(catalog) : "NULL"); if (!catalog) return;');
    await route.fulfill({
      response,
      body,
      headers: response.headers()
    });
  });
  await page.goto('http://localhost:8081');
  await page.waitForTimeout(2000);
  await browser.close();
})();
