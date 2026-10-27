import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDomain, normalizeDomain } from '../checks.js';

const TYPE_CODES = { MX: 15, TXT: 16 };

/**
 * A stub DoH endpoint. `records` maps "TYPE name" keys to arrays of DNS
 * answer data strings; a missing key means "no records" (NOERROR, empty
 * answer). A value of 'down' makes the endpoint itself fail.
 */
function stubFetch(records = {}) {
  return async (url) => {
    const parsed = new URL(url);
    const name = parsed.searchParams.get('name');
    const type = parsed.searchParams.get('type');
    const data = records[`${type} ${name}`];

    if (data === 'down') {
      throw new Error('network down');
    }

    return {
      ok: true,
      json: async () => ({
        Status: 0,
        Answer: (data ?? []).map((value) => ({ name, type: TYPE_CODES[type], data: value })),
      }),
    };
  };
}

function downFetch() {
  return Promise.reject(new Error('network down'));
}

function baseRecords() {
  return {
    'MX example.com': ['10 mail.example.com.'],
    'TXT example.com': ['"v=spf1 include:amazonses.com a:mail.example.com ~all"'],
    'TXT google._domainkey.example.com': ['"v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ"'],
    'TXT _dmarc.example.com': ['"v=DMARC1; p=reject; rua=mailto:dmarc@example.com"'],
  };
}

function checkFor(result, key) {
  return result.checks.find((check) => check.key === key);
}

test('normalizeDomain accepts domains, emails and pasted URLs', () => {
  assert.equal(normalizeDomain('example.com'), 'example.com');
  assert.equal(normalizeDomain('  Example.COM  '), 'example.com');
  assert.equal(normalizeDomain('https://www.example.com/path?x=1'), 'example.com');
  assert.equal(normalizeDomain('bob@sub.example.co.uk'), 'sub.example.co.uk');
  assert.equal(normalizeDomain('example.com:8080'), 'example.com');
  assert.equal(normalizeDomain('example.com.'), 'example.com');
  assert.equal(normalizeDomain('www.example.com'), 'example.com');
});

test('normalizeDomain rejects things that are not domains', () => {
  assert.equal(normalizeDomain(''), null);
  assert.equal(normalizeDomain('not a domain'), null);
  assert.equal(normalizeDomain('localhost'), null);
  assert.equal(normalizeDomain('example'), null);
  assert.equal(normalizeDomain('-bad.example.com'), null);
});

test('an all-pass domain yields four ok verdicts, in MX-SPF-DKIM-DMARC order', async () => {
  const result = await checkDomain('example.com', { fetchImpl: stubFetch(baseRecords()) });

  assert.deepEqual(result.summary, { ok: 4, warn: 0, fail: 0 });
  assert.deepEqual(result.checks.map((check) => check.key), ['mx', 'spf', 'dkim', 'dmarc']);
  assert.equal(checkFor(result, 'mx').summary, 'Mail for example.com is handled by 1 server, listed by preference.');
  assert.match(checkFor(result, 'dkim').summary, /public key is published at the "google" selector/);
});

test('two SPF records fail with the RFC 7208 explanation', async () => {
  const records = baseRecords();
  records['TXT example.com'] = ['"v=spf1 include:a.com ~all"', '"v=spf1 include:b.com ~all"'];

  const result = await checkDomain('example.com', { fetchImpl: stubFetch(records) });
  const spf = checkFor(result, 'spf');

  assert.equal(spf.status, 'fail');
  assert.match(spf.summary, /RFC 7208/);
  assert.match(spf.detail.join('\n'), /Records found: .*include:a\.com.*include:b\.com/);
});

test('a +all SPF record fails, an ?all record only warns', async () => {
  const plusAll = baseRecords();
  plusAll['TXT example.com'] = ['"v=spf1 +all"'];

  const failing = await checkDomain('example.com', { fetchImpl: stubFetch(plusAll) });
  assert.equal(checkFor(failing, 'spf').status, 'fail');
  assert.match(checkFor(failing, 'spf').summary, /spoofed freely/);

  const neutral = baseRecords();
  neutral['TXT example.com'] = ['"v=spf1 ?all"'];

  const warning = await checkDomain('example.com', { fetchImpl: stubFetch(neutral) });
  assert.equal(checkFor(warning, 'spf').status, 'warn');
  assert.match(checkFor(warning, 'spf').summary, /neutral/);
});

test('an SPF record over the 10-lookup limit warns with the count', async () => {
  const records = baseRecords();
  const includes = Array.from({ length: 11 }, (_, index) => `include:s${index}.example.com`).join(' ');
  records['TXT example.com'] = [`"v=spf1 ${includes} ~all"`];

  const result = await checkDomain('example.com', { fetchImpl: stubFetch(records) });
  const spf = checkFor(result, 'spf');

  assert.equal(spf.status, 'warn');
  assert.match(spf.summary, /more than 10 DNS lookups \(11\)/);
});

test('a domain with no MX record warns instead of failing', async () => {
  const records = baseRecords();
  delete records['MX example.com'];

  const result = await checkDomain('example.com', { fetchImpl: stubFetch(records) });

  assert.equal(checkFor(result, 'mx').status, 'warn');
  assert.match(checkFor(result, 'mx').summary, /cannot receive mail/);
  assert.equal(result.summary.ok, 3);
});

test('a null MX record is named as the deliberate send-only setup it is', async () => {
  const records = baseRecords();
  records['MX example.com'] = ['0 .'];

  const result = await checkDomain('example.com', { fetchImpl: stubFetch(records) });

  assert.equal(checkFor(result, 'mx').status, 'warn');
  assert.match(checkFor(result, 'mx').summary, /null MX record \(RFC 7505\)/);
});

test('a revoked DKIM key (empty p=) warns that signatures will fail', async () => {
  const records = baseRecords();
  records['TXT google._domainkey.example.com'] = ['"v=DKIM1; p="'];

  const result = await checkDomain('example.com', { fetchImpl: stubFetch(records) });
  const dkim = checkFor(result, 'dkim');

  assert.equal(dkim.status, 'warn');
  assert.match(dkim.summary, /p= value is empty/);
});

test('no DKIM under any probed selector is phrased as "not proof of a problem"', async () => {
  const records = baseRecords();
  delete records['TXT google._domainkey.example.com'];

  const result = await checkDomain('example.com', { fetchImpl: stubFetch(records) });
  const dkim = checkFor(result, 'dkim');

  assert.equal(dkim.status, 'warn');
  assert.match(dkim.summary, /not proof of a problem/);
});

test('two DMARC records fail — receivers treat the domain as having none', async () => {
  const records = baseRecords();
  records['TXT _dmarc.example.com'] = ['"v=DMARC1; p=none"', '"v=DMARC1; p=quarantine"'];

  const result = await checkDomain('example.com', { fetchImpl: stubFetch(records) });
  const dmarc = checkFor(result, 'dmarc');

  assert.equal(dmarc.status, 'fail');
  assert.match(dmarc.summary, /treat the domain as having none/);
});

test('p=none warns and suggests tightening to p=quarantine', async () => {
  const records = baseRecords();
  records['TXT _dmarc.example.com'] = ['"v=DMARC1; p=none; rua=mailto:dmarc@example.com"'];

  const result = await checkDomain('example.com', { fetchImpl: stubFetch(records) });
  const dmarc = checkFor(result, 'dmarc');

  assert.equal(dmarc.status, 'warn');
  assert.match(dmarc.detail.join('\n'), /tighten to p=quarantine/);
});

test('when no resolver answers, every check says so — never "no records"', async () => {
  const result = await checkDomain('example.com', { fetchImpl: downFetch, timeoutMs: 50 });

  assert.deepEqual(result.summary, { ok: 0, warn: 4, fail: 0 });

  for (const check of result.checks) {
    assert.match(check.summary, /could not be reached/);
  }
});

test('live: github.com has four checks and no failures', { timeout: 30000 }, async () => {
  const result = await checkDomain('github.com');

  assert.equal(result.checks.length, 4);
  assert.equal(result.summary.fail, 0);
});

test('live: sendfeather.com returns four checks with a working MX', { timeout: 30000 }, async () => {
  const result = await checkDomain('sendfeather.com');

  assert.equal(result.checks.length, 4);
  assert.equal(checkFor(result, 'mx').status, 'ok');
});
