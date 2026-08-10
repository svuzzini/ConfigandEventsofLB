/**
 * Test harness loader: extracts the inline app module from avi-analyzer.html
 * and imports it via a data: URL, so `node --test tools/tests/` exercises the
 * exact code the browser runs. No build step; the HTML file is the source of
 * truth. The module's UI section is guarded by `typeof document`, so importing
 * it in Node loads only the pure logic.
 */
import { readFileSync } from 'node:fs';

const htmlPath = new URL('../avi-analyzer.html', import.meta.url);
const html = readFileSync(htmlPath, 'utf8');
const m = html.match(/<script type="module" id="app">([\s\S]*?)<\/script>/);
if (!m) throw new Error('avi-analyzer.html: could not find <script type="module" id="app">');

export const app = await import(
  'data:text/javascript;base64,' + Buffer.from(m[1], 'utf8').toString('base64')
);
