/**
 * Loads the extension into a scratch headless Chrome via CDP
 * (Extensions.loadUnpacked over the pipe transport — Chrome 137+ no longer
 * honors --load-extension), opens the popup page, runs a check through the
 * real UI, and reports the verdicts, any console errors, and a screenshot.
 * Dev-only; macOS + Google Chrome.
 *
 * Usage: node test/chrome-smoke.mjs [domain]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DOMAIN = process.argv[2] ?? 'github.com';
const KEEP_PROFILE = process.argv.includes('--keep');

/** CDP over --remote-debugging-pipe: JSON messages in on fd3, out on fd4, NUL-delimited. */
class PipeCDP {
  constructor(writeStream, readStream) {
    this.writeStream = writeStream;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.buffer = '';

    readStream.setEncoding('utf8');
    readStream.on('data', (chunk) => {
      this.buffer += chunk;

      let boundary;
      while ((boundary = this.buffer.indexOf('\0')) !== -1) {
        const raw = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 1);

        if (raw.trim() === '') {
          continue;
        }

        try {
          this.dispatch(JSON.parse(raw));
        } catch {
          // Ignore anything that is not a protocol message.
        }
      }
    });
  }

  dispatch(message) {
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);

      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }

      return;
    }

    this.events.push(message);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      const payload = { id, method, params };
      if (sessionId) {
        payload.sessionId = sessionId;
      }

      this.writeStream.write(`${JSON.stringify(payload)}\0`);
    });
  }

  close() {
    try {
      this.writeStream.end();
    } catch {
      // Stream already closed.
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(attempt, { timeoutMs = 20000, everyMs = 250, what }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const value = await attempt();

      if (value !== undefined && value !== null && value !== false) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(everyMs);
  }

  throw new Error(`timed out waiting for ${what}${lastError ? ` — ${lastError.message}` : ''}`);
}

const profile = await mkdtemp(join(tmpdir(), 'sf-ext-smoke-'));

const chrome = spawn(CHROME, [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profile}`,
  '--enable-unsafe-extension-debugging',
  '--remote-debugging-pipe',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });

let chromeErrors = '';
chrome.stderr.on('data', (chunk) => {
  chromeErrors += chunk;
});

let cdp;
let exitCode = 0;

try {
  cdp = new PipeCDP(chrome.stdio[3], chrome.stdio[4]);

  const { id: extensionId } = await waitFor(
    async () => await cdp.send('Extensions.loadUnpacked', { path: REPO }),
    { timeoutMs: 20000, what: 'Extensions.loadUnpacked' },
  );

  const { targetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/popup.html`,
  });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 400, height: 620, deviceScaleFactor: 2, mobile: false }, sessionId);

  if (process.env.FORCE_LIGHT) {
    await cdp.send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
  }

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true }, sessionId);

    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }

    return result?.value;
  };

  await waitFor(
    async () => (await evaluate('document.readyState')) === 'complete',
    { what: 'the popup page to load' },
  );

  // The tab APIs must be reachable from the popup (activeTab wiring).
  const tabsApiWorks = await evaluate(
    `chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs.length >= 1)`,
  );

  await evaluate(`(() => {
    document.getElementById('domain').value = ${JSON.stringify(DOMAIN)};
    document.getElementById('check-form').requestSubmit();

    return true;
  })()`);

  const headline = await waitFor(
    async () => (await evaluate(`document.getElementById('verdict-headline')?.textContent || ''`)) || null,
    { timeoutMs: 45000, what: 'the check to finish' },
  );

  const checks = await evaluate(`Array.from(document.querySelectorAll('.check')).map((el) => ({
    label: el.querySelector('.check-label').textContent,
    status: el.className.includes('check--fail') ? 'fail'
      : el.className.includes('check--warn') ? 'warn' : 'ok',
    summary: el.querySelector('.check-summary').textContent,
  }))`);

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const screenshotPath = join(tmpdir(), `sf-ext-popup-${DOMAIN}.png`);
  await writeFile(screenshotPath, Buffer.from(data, 'base64'));

  const consoleErrors = cdp.events
    .filter((message) => message.sessionId === sessionId)
    .filter((message) => message.method === 'Runtime.exceptionThrown'
      || (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
      || (message.method === 'Log.entryAdded' && message.params.entry.level === 'error'))
    .map((message) => message.params?.exceptionDetails?.exception?.description
      ?? message.params?.entry?.text
      ?? message.params?.args?.map((arg) => arg.value ?? arg.description).join(' '));

  console.log(JSON.stringify({
    extensionId,
    domain: DOMAIN,
    tabsApiWorks,
    headline,
    checks,
    consoleErrors,
    screenshotPath,
  }, null, 2));

  if (consoleErrors.length > 0 || tabsApiWorks !== true) {
    exitCode = 1;
  }
} catch (error) {
  console.error(`smoke test failed: ${error.message}`);
  console.error(chromeErrors.split('\n').slice(-8).join('\n'));
  exitCode = 1;
} finally {
  cdp?.close();
  chrome.kill('SIGTERM');
  await sleep(500);
  chrome.kill('SIGKILL');

  if (!KEEP_PROFILE) {
    await rm(profile, { recursive: true, force: true });
  }
}

process.exit(exitCode);
