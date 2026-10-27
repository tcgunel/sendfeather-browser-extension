import { checkDomain, normalizeDomain } from './checks.js';

const api = globalThis.browser ?? globalThis.chrome;

const form = document.getElementById('check-form');
const input = document.getElementById('domain');
const checkButton = document.getElementById('check-button');
const formNote = document.getElementById('form-note');
const intro = document.getElementById('intro');
const results = document.getElementById('results');
const verdictBox = document.getElementById('verdict');
const verdictHeadline = document.getElementById('verdict-headline');
const verdictNote = document.getElementById('verdict-note');
const checksList = document.getElementById('checks');

const STATUS_LABEL = { ok: 'Passed', warn: 'Review', fail: 'Failed' };

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const domain = normalizeDomain(input.value);

  if (!domain) {
    showNote('That does not look like a domain — try example.com.');
    input.focus();

    return;
  }

  hideNote();
  setBusy(true);

  try {
    const result = await checkDomain(domain);

    render(result);
  } catch {
    showNote('The check could not run — try again in a moment.');
  } finally {
    setBusy(false);
  }
});

for (const link of document.querySelectorAll('[data-external]')) {
  link.addEventListener('click', (event) => {
    event.preventDefault();

    api.tabs.create({ url: link.href });
    window.close();
  });
}

// Prefill from the active tab: the popup opens on a page, so that page's
// domain is usually the one the user wants checked. activeTab grants URL
// access for exactly this moment.
async function prefillFromActiveTab() {
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const url = tabs?.[0]?.url;

    if (!url) {
      return;
    }

    const parsed = new URL(url);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return;
    }

    const domain = normalizeDomain(parsed.hostname);

    if (domain && input.value === '') {
      input.value = domain;
    }
  } catch {
    // No tab access — the user can type a domain.
  }
}

function render(result) {
  const { ok, warn, fail } = result.summary;
  const total = ok + warn + fail;

  let tone;
  let headline;
  let note;

  if (fail > 0) {
    tone = 'fail';
    headline = `${fail} of ${total} checks ${fail === 1 ? 'needs' : 'need'} attention`;
    note = `Mail from ${result.domain} can still deliver, but fixing these first is what keeps it out of spam.`;
  } else if (warn > 0) {
    tone = 'warn';
    headline = `Nothing missing — ${warn} of ${total} checks ${warn === 1 ? 'is' : 'are'} worth a look`;
    note = `Everything a receiver can verify for ${result.domain} is in place; the notes below are what to improve next.`;
  } else {
    tone = 'ok';
    headline = `All ${total} checks passed`;
    note = `Mail from ${result.domain} is authenticated: receivers can verify who sent it, and DMARC tells them what to do with impostors.`;
  }

  verdictBox.className = `verdict verdict--${tone}`;
  verdictHeadline.textContent = headline;
  verdictNote.textContent = note;

  checksList.replaceChildren(...result.checks.map(renderCheck));

  intro.hidden = true;
  results.hidden = false;
}

// Everything below builds nodes with textContent — record values come from
// live DNS and are treated as untrusted input, never as markup.
function renderCheck(check) {
  const item = document.createElement('li');
  item.className = `check check--${check.status}`;

  const head = document.createElement('div');
  head.className = 'check-head';

  const label = document.createElement('span');
  label.className = 'check-label';
  label.textContent = check.label;

  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.textContent = STATUS_LABEL[check.status];

  head.append(label, chip);

  const summary = document.createElement('p');
  summary.className = 'check-summary';
  summary.textContent = check.summary;

  item.append(head, summary);

  if (check.detail.length > 0) {
    const details = document.createElement('details');
    const detailsSummary = document.createElement('summary');
    detailsSummary.textContent = 'Details';

    details.appendChild(detailsSummary);

    for (const line of check.detail) {
      const paragraph = document.createElement('p');
      paragraph.className = 'detail-line';
      paragraph.textContent = line;

      details.appendChild(paragraph);
    }

    item.appendChild(details);
  }

  return item;
}

function setBusy(busy) {
  checkButton.disabled = busy;
  checkButton.textContent = busy ? 'Checking…' : 'Check';
}

function showNote(message) {
  formNote.textContent = message;
  formNote.hidden = false;
}

function hideNote() {
  formNote.hidden = true;
}

prefillFromActiveTab();
