const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:8081');
  await page.waitForTimeout(2000);
  const options = await page.evaluate(() => {
    const sel = document.querySelector('.controls-panel select');
    return sel ? sel.options.length : 'no select';
  });
  console.log('OPTIONS:', options);
  const profilesCount = await page.evaluate(() => window.app ? window.app.workspace.catalog.profiles.length : 'no app');
  console.log('PROFILES:', profilesCount);
  await browser.close();
})();
