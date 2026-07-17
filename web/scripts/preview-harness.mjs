import { preview } from 'vite';
import puppeteer from 'puppeteer';

export async function startPreview() {
  const server = await preview({
    root: new URL('..', import.meta.url).pathname,
    preview: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite preview did not expose a TCP address.');
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

export async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--no-sandbox', '--use-angle=swiftshader'],
  });
}

export async function openReadyPage(browser, url, viewport = { width: 1280, height: 720 }, configure = undefined) {
  const page = await browser.newPage();
  await configure?.(page);
  await page.setViewport(viewport);
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForSelector('#app-boot.ready', { timeout: 60_000 });
  return page;
}
