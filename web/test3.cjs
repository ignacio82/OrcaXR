const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('LOG:', msg.text()));
  await page.goto('http://localhost:8081');
  try {
    await page.waitForSelector('select', { timeout: 5000 });
    const selects = await page.evaluate(() => {
      const sels = document.querySelectorAll('select');
      return Array.from(sels).map(s => s.options.length);
    });
    console.log('SELECTS:', selects);
  } catch (e) {
    console.log('TIMEOUT WAITING FOR OPTIONS');
  }
  await browser.close();
})();
