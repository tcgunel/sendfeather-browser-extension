/**
 * The popup's check engine: reads a domain's MX, SPF, DKIM and DMARC records
 * through public DNS-over-HTTPS endpoints and turns each one into a verdict.
 *
 * The sentences here are the same ones the site's checker serves — the tool
 * page, its FAQPage structured data and llms-full.txt all carry them — so a
 * person quoting the extension quotes the platform's own words.
 *
 * Endpoint fallback and the reachability contract mirror the platform's
 * DnsOverHttps client: `null` means "no endpoint could answer", never "the
 * name has no records".
 */

export const DKIM_SELECTORS = [
  'default', 'google', 'selector1', 'selector2', 's1', 's2', 'k1',
  'mail', 'dkim', 'amazonses', 'cf2024-1', 'sendfeather',
];

const ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
];

const TYPE_CODES = { A: 1, CNAME: 5, MX: 15, TXT: 16, SRV: 33 };

/**
 * Mirror of the platform's ToolsController::normalizeDomain: accepts a
 * domain, an email address or a pasted URL and returns the bare lower-cased
 * domain — or null when it is not a valid registrable-looking name.
 */
export function normalizeDomain(input) {
  let value = String(input ?? '').trim().toLowerCase();

  if (value.includes('@')) {
    value = value.slice(value.lastIndexOf('@') + 1);
  }

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.replace(/[/\s:?#][\s\S]*$/, '');
  value = value.replace(/\.+$/, '');
  value = value.replace(/^www\./, '');

  if (
    value === ''
    || value.length > 253
    || !/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)
  ) {
    return null;
  }

  return value;
}

/**
 * @returns {Promise<{domain: string, summary: {ok: number, warn: number, fail: number}, checks: Array<{key: string, label: string, status: string, summary: string, detail: string[]}>}>}
 */
export async function checkDomain(domain, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const resolve = createResolver(fetchImpl, timeoutMs);

  const checks = await Promise.all([
    checkMx(domain, resolve),
    checkSpf(domain, resolve),
    checkDkim(domain, resolve),
    checkDmarc(domain, resolve),
  ]);

  const summary = { ok: 0, warn: 0, fail: 0 };

  for (const check of checks) {
    summary[check.status] += 1;
  }

  return { domain, summary, checks };
}

function createResolver(fetchImpl, timeoutMs) {
  return async function resolve(name, type) {
    const typeCode = TYPE_CODES[type] ?? 0;

    for (const endpoint of ENDPOINTS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
        const response = await fetchImpl(url, {
          headers: { accept: 'application/dns-json' },
          signal: controller.signal,
        });

        if (!response.ok) {
          continue;
        }

        const body = await response.json();
        const answers = Array.isArray(body?.Answer) ? body.Answer : [];

        return answers
          .filter((answer) => typeCode === 0 || Number(answer?.type ?? 0) === typeCode)
          .map((answer) => ({ type: Number(answer?.type ?? 0), data: String(answer?.data ?? '') }));
      } catch {
        // Network error or timeout — fall through to the next endpoint.
      } finally {
        clearTimeout(timer);
      }
    }

    return null;
  };
}

async function checkMx(domain, resolve) {
  const answers = await resolve(domain, 'MX');

  if (answers === null) {
    return unreachable('mx', 'MX records');
  }

  const hosts = answers
    .map((answer) => parseMx(answer.data))
    .filter((host) => host !== null)
    .sort((a, b) => a.preference - b.preference);

  // RFC 7505: a single "0 ." record says the domain accepts no mail at all —
  // a deliberate send-only setup, worth naming rather than reading as a
  // missing configuration.
  if (hosts.length === 1 && hosts[0].host === '') {
    return verdict('mx', 'MX records', 'warn',
      'This domain publishes a null MX record (RFC 7505): it accepts no mail at all.',
      ['A send-only domain publishes "0 ." on purpose so senders fail fast instead of retrying. If you expected to receive mail here, replace it with your provider\'s MX host.']);
  }

  if (hosts.length === 0) {
    return verdict('mx', 'MX records', 'warn',
      'No MX record: this domain cannot receive mail.',
      ['That is fine for a send-only domain, but a domain meant to receive replies needs at least one MX record.',
        'For Sendfeather mailboxes, the dashboard shows the exact MX host to publish.']);
  }

  return verdict('mx', 'MX records', 'ok',
    `Mail for ${domain} is handled by ${hosts.length} server${hosts.length === 1 ? '' : 's'}, listed by preference.`,
    hosts.map((host) => `${String(host.preference).padStart(2, ' ')} — ${host.host}`));
}

async function checkSpf(domain, resolve) {
  const answers = await resolve(domain, 'TXT');

  if (answers === null) {
    return unreachable('spf', 'SPF');
  }

  const records = answers
    .map((answer) => txtValue(answer.data))
    .filter((value) => value.toLowerCase().startsWith('v=spf1'));

  if (records.length > 1) {
    return verdict('spf', 'SPF', 'fail',
      'More than one SPF record is published. Receivers treat that as a permanent error and stop evaluating SPF for the domain entirely — RFC 7208 allows exactly one.',
      ['Merge the mechanisms into a single record and delete the others.',
        `Records found: ${records.join(' | ')}`]);
  }

  if (records.length === 0) {
    return verdict('spf', 'SPF', 'fail',
      'No SPF record: receivers have no list of servers allowed to send mail for this domain, so your domain can be spoofed.',
      ['Publish a TXT record at the domain root starting with v=spf1, listing every service that sends for you, and ending with an all mechanism — for example "v=spf1 include:… ~all".',
        'A new sending domain that publishes SPF on day one starts with a clean reputation record.']);
  }

  const record = records[0];
  const lookups = spfLookupCount(record);
  const all = spfAll(record);

  const detail = [
    `Record: ${record}`,
    `The record uses ${lookups} DNS lookups; receivers allow at most 10.`,
  ];

  if (all) {
    detail.push(`Unlisted senders: ${all.effect}`);
  }

  if (all && all.qualifier === '+') {
    return verdict('spf', 'SPF', 'fail',
      'The SPF record ends in "+all", which authorizes every server on the internet to send mail as this domain — SPF is effectively disabled and your domain can be spoofed freely.',
      detail);
  }

  if (lookups > 10) {
    return verdict('spf', 'SPF', 'warn',
      `The SPF record needs more than 10 DNS lookups (${lookups}). Any receiver that hits the limit returns a permanent error and treats the message as unauthenticated — even though the record looks fine elsewhere.`,
      detail);
  }

  if (all && all.qualifier === '?') {
    return verdict('spf', 'SPF', 'warn',
      'The SPF record ends in "?all", which makes unlisted senders neutral — the record is present but does not restrict who can send.',
      detail);
  }

  return verdict('spf', 'SPF', 'ok',
    'The SPF record lists who may send for this domain and stays within the 10-lookup limit receivers enforce.',
    detail);
}

async function checkDkim(domain, resolve) {
  const answersBySelector = await Promise.all(
    DKIM_SELECTORS.map((selector) => resolve(`${selector}._domainkey.${domain}`, 'TXT')),
  );

  if (answersBySelector.some((answers) => answers === null)) {
    return unreachable('dkim', 'DKIM');
  }

  const found = {};

  DKIM_SELECTORS.forEach((selector, index) => {
    for (const answer of answersBySelector[index]) {
      const value = txtValue(answer.data);

      if (value.toLowerCase().startsWith('v=dkim1') || value.includes('p=')) {
        found[selector] = value;

        break;
      }
    }
  });

  const selectors = Object.keys(found);

  if (selectors.length === 0) {
    return verdict('dkim', 'DKIM', 'warn',
      'No DKIM record was found under the common selectors this check probes. That is not proof of a problem: the selector is chosen by your sending provider, so this check can only guess.',
      [`Probed: ${DKIM_SELECTORS.join(', ')} — the defaults common providers ship.`,
        'To find yours, look for a <selector>._domainkey record in your sending provider\'s dashboard. For Sendfeather, the domain page shows the exact DKIM record to publish.']);
  }

  const selector = selectors[0];
  const value = found[selector];
  const hasKey = /\bp=[A-Za-z0-9+/]{10,}/.test(value);

  if (!hasKey) {
    return verdict('dkim', 'DKIM', 'warn',
      `A DKIM record exists at the "${selector}" selector, but its p= value is empty — that retires the key, and messages signed under this selector will fail verification.`,
      [`Record: ${selector}._domainkey.${domain}.`]);
  }

  const detail = [`Record: ${selector}._domainkey.${domain}.`];

  if (selectors.length > 1) {
    detail.push(`Also found: ${selectors.slice(1).join(', ')}. Multiple selectors are normal — one per service that signs for you.`);
  }

  return verdict('dkim', 'DKIM', 'ok',
    `A DKIM public key is published at the "${selector}" selector, so receivers can verify signatures made with it.`,
    detail);
}

async function checkDmarc(domain, resolve) {
  const answers = await resolve(`_dmarc.${domain}`, 'TXT');

  if (answers === null) {
    return unreachable('dmarc', 'DMARC');
  }

  const records = answers
    .map((answer) => txtValue(answer.data))
    .filter((value) => value.toLowerCase().startsWith('v=dmarc1'));

  if (records.length > 1) {
    return verdict('dmarc', 'DMARC', 'fail',
      'More than one DMARC record is published. Receivers cannot choose between them, skip the policy and treat the domain as having none.',
      ['Keep a single _dmarc TXT record and merge its tags.',
        `Records found: ${records.join(' | ')}`]);
  }

  if (records.length === 0) {
    return verdict('dmarc', 'DMARC', 'fail',
      'No DMARC record: receivers have no instructions for mail that fails SPF and DKIM, and spoofed mail faces no policy at all.',
      [`Start with a monitoring record: "v=DMARC1; p=none; rua=mailto:you@${domain}". It changes nothing yet but starts the aggregate reports that show who sends as your domain.`,
        'Once the reports are clean, tighten p=none to p=quarantine, then p=reject. Mailbox providers have required DMARC from bulk senders since 2024.']);
  }

  const record = records[0];
  const policyMatch = /(?:^|;)\s*p\s*=\s*(none|quarantine|reject)\b/i.exec(record);

  if (!policyMatch) {
    return verdict('dmarc', 'DMARC', 'fail',
      'The DMARC record has no valid p= policy tag, so receivers treat it as invalid and publish no policy for this domain.',
      [`Record: ${record}`,
        'A DMARC record needs a policy: p=none to monitor, p=quarantine or p=reject to act.']);
  }

  const policy = policyMatch[1].toLowerCase();
  const detail = [`Record: ${record}`];

  const rua = /rua\s*=\s*([^;\s]+)/i.exec(record);

  if (rua) {
    detail.push(`Aggregate reports go to ${rua[1].split(',')[0]}.`);
  } else {
    detail.push('No rua= address: add one to receive the aggregate reports that show who sends as your domain.');
  }

  const pct = /pct\s*=\s*(\d+)/i.exec(record);

  if (pct && Number(pct[1]) < 100) {
    detail.push(`pct=${pct[1]} applies the policy to only ${pct[1]}% of failing messages.`);
  }

  if (policy === 'reject') {
    return verdict('dmarc', 'DMARC', 'ok',
      'p=reject: receivers reject mail that fails authentication for this domain — the strictest and most protective policy.', detail);
  }

  if (policy === 'quarantine') {
    return verdict('dmarc', 'DMARC', 'ok',
      'p=quarantine: receivers treat mail that fails authentication for this domain as suspicious. The next step is p=reject once the reports confirm nothing legitimate fails.',
      [...detail, 'Moving to p=reject closes the last gap — quarantine still lets some failing mail land in spam instead of the bin.']);
  }

  return verdict('dmarc', 'DMARC', 'warn',
    'p=none: DMARC is only monitoring — receivers take no action against mail that fails SPF and DKIM, so spoofed messages are still delivered.',
    [...detail, 'That is the standard first stage: collect reports, fix what the reports uncover, then tighten to p=quarantine, then p=reject.']);
}

function unreachable(key, label) {
  return verdict(key, label, 'warn',
    'The DNS resolver could not be reached — check again in a moment.',
    ['Nothing is cached — retrying re-queries live DNS.']);
}

function verdict(key, label, status, summary, detail) {
  return { key, label, status, summary, detail: [...detail] };
}

/**
 * DoH returns TXT in presentation format ("quoted chunks"); SPF, DKIM and
 * DMARC values never contain quote characters, so stripping them rejoins a
 * record split across chunks into the published value.
 */
function txtValue(data) {
  return String(data).replace(/"/g, '').trim();
}

function parseMx(data) {
  const parts = String(data).trim().split(/\s+/);

  if (parts.length !== 2 || !/^\d+$/.test(parts[0])) {
    return null;
  }

  return {
    preference: Number(parts[0]),
    host: parts[1].toLowerCase().replace(/\.+$/, ''),
  };
}

/**
 * The mechanisms that cost a DNS lookup under RFC 7208 §4.6.4 — include, a,
 * mx, ptr, exists, and redirect. ip4/ip6/all are free.
 */
function spfLookupCount(record) {
  let count = 0;

  for (let term of String(record).trim().split(/\s+/)) {
    term = term.toLowerCase().replace(/^[+~?-]+/, '');

    if (term.startsWith('include:') || term.startsWith('exists:') || term.startsWith('redirect=')) {
      count += 1;

      continue;
    }

    if (term === 'a' || term.startsWith('a:') || term.startsWith('a/')
      || term === 'mx' || term.startsWith('mx:') || term.startsWith('mx/')
      || term === 'ptr' || term.startsWith('ptr:')) {
      count += 1;
    }
  }

  return count;
}

/**
 * The all mechanism and its qualifier: "+" or none means everyone passes,
 * "-" means everyone else fails, "~" soft-fails, "?" is neutral.
 */
function spfAll(record) {
  const match = /(?:^|\s)([+\-~?]?)all(?:\s|$)/i.exec(record);

  if (!match) {
    return null;
  }

  const qualifier = match[1] === '' ? '+' : match[1];

  const effects = {
    '+': 'anything not listed passes SPF — including anyone spoofing the domain.',
    '-': 'anything not listed fails SPF (the recommended default).',
    '~': 'anything not listed is flagged as suspect (softfail) — receivers usually still deliver it.',
  };

  return {
    qualifier,
    effect: effects[qualifier] ?? 'anything not listed is treated as neutral — unlisted senders are neither allowed nor refused.',
  };
}
