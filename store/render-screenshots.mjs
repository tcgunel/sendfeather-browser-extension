/**
 * Composes the 1280×800 store screenshots from the raw popup captures that
 * test/chrome-smoke.mjs leaves in dist/screenshots/. Renders a small HTML
 * layout in headless Chrome and captures it at exactly 1280×800.
 *
 * Usage: node store/render-screenshots.mjs
 * Inputs:  dist/screenshots/popup-light-sendfeather.png
 *          dist/screenshots/popup-dark-github.png
 * Outputs: store/screenshots/listing-1-light-1280x800.png
 *          store/screenshots/listing-2-dark-1280x800.png
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const THEMES = {
  light: {
    background: '#faf9f6',
    foreground: '#20242e',
    accent: '#c93e0e',
    drop: 'rgb(32 36 46 / 0.18)',
    mirror: false,
    popup: join(REPO, 'dist', 'screenshots', 'popup-light-sendfeather.png'),
    output: join(REPO, 'store', 'screenshots', 'listing-1-light-1280x800.png'),
  },
  dark: {
    background: '#15171c',
    foreground: '#e8e9eb',
    accent: '#ff6a3d',
    drop: 'rgb(0 0 0 / 0.55)',
    mirror: true,
    popup: join(REPO, 'dist', 'screenshots', 'popup-dark-github.png'),
    output: join(REPO, 'store', 'screenshots', 'listing-2-dark-1280x800.png'),
  },
};

function layout(theme, popupBase64) {
  const copy = `
    <div class="copy">
      <div class="eyebrow">Email deliverability checker</div>
      <h1>Check any domain&rsquo;s email setup &mdash; in plain language</h1>
      <ul>
        <li>MX, SPF, DKIM and DMARC, read the way mailbox providers read them</li>
        <li>Verdicts say what receivers will actually do &mdash; not a score</li>
        <li>Runs entirely in your browser: no account, no analytics, nothing stored</li>
      </ul>
    </div>`;

  const shot = `<div class="shot"><img src="data:image/png;base64,${popupBase64}" alt=""></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 1280px; height: 800px; overflow: hidden; }
  body {
    display: flex;
    align-items: center;
    gap: 84px;
    padding: 0 110px;
    background: ${theme.background};
    color: ${theme.foreground};
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  .copy { flex: 1; min-width: 0; }
  .eyebrow {
    color: ${theme.accent};
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  h1 {
    margin-top: 20px;
    font-size: 46px;
    line-height: 1.12;
    letter-spacing: -0.02em;
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin-top: 30px;
    padding: 0;
    list-style: none;
  }
  li {
    position: relative;
    padding-left: 26px;
    font-size: 19px;
    line-height: 1.45;
    color: ${theme.foreground};
  }
  li::before {
    content: '';
    position: absolute;
    top: 11px;
    left: 2px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${theme.accent};
  }
  .shot { flex: none; }
  .shot img {
    display: block;
    height: 690px;
    border-radius: 16px;
    box-shadow: 0 30px 70px ${theme.drop};
  }
</style>
</head>
<body>
${theme.mirror ? shot + copy : copy + shot}
</body>
</html>`;
}

async function renderTheme(name, theme) {
  if (!existsSync(theme.popup)) {
    throw new Error(`missing raw capture ${theme.popup} — run: node test/chrome-smoke.mjs <domain>`);
  }

  const popupBase64 = (await readFile(theme.popup)).toString('base64');
  const htmlPath = join(REPO, 'store', `.tmp-listing-${name}.html`);
  await writeFile(htmlPath, layout(theme, popupBase64));

  await mkdir(dirname(theme.output), { recursive: true });

  await new Promise((resolve, reject) => {
    const chrome = spawn(CHROME, [
      '--headless=new',
      '--no-first-run',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--window-size=1280,800',
      `--screenshot=${theme.output}`,
      `file://${htmlPath}`,
    ], { stdio: 'ignore' });

    chrome.on('error', reject);
    chrome.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`chrome exited ${code}`))));
  });

  await rm(htmlPath);

  console.log(`${name}: ${theme.output}`);
}

for (const [name, theme] of Object.entries(THEMES)) {
  await renderTheme(name, theme);
}
