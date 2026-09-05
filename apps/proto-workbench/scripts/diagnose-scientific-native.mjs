import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const root = resolve(process.argv[2]);
const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
if (!relative(repository, root).replaceAll('\\', '/').startsWith('build/upgrade-20260904/native-qa/')) throw new Error('Outside owned QA root');
const [port, endpoint] = (await readFile(join(root, 'profile', 'DevToolsActivePort'), 'utf8')).trim().split('\n');
if (!/^\d+$/.test(port) || !/^\/devtools\/browser\/[a-z0-9-]+$/.test(endpoint)) throw new Error('Invalid owned endpoint');
const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`, { timeout: 10000 });
const pages = browser.contexts().flatMap(context => context.pages());
const output = [];
for (const page of pages) {
  const data = { url: page.url(), title: await page.title(), body: (await page.locator('body').innerText()).slice(0, 10000) };
  await page.screenshot({ path: join(root, 'evidence', 'diagnostic-native.png') }); output.push(data);
}
await writeFile(join(root, 'diagnostic.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
await browser.close();
