// Tests for the shared HTTP helpers (validation + cors).
const test = require('node:test');
const assert = require('node:assert');

process.env.CORS_ORIGINS = '*';
const http = require('../api/lib/http.cjs');

test('parsePositiveInt accepts integers', () => {
  assert.strictEqual(http.parsePositiveInt('5', 'x'), 5);
});

test('parsePositiveInt rejects bad input', () => {
  assert.throws(() => http.parsePositiveInt('abc', 'x'));
  assert.throws(() => http.parsePositiveInt('0', 'x'));
  assert.throws(() => http.parsePositiveInt('-1', 'x'));
});

test('parseEpisodeNumber accepts 0 and decimals', () => {
  assert.strictEqual(http.parseEpisodeNumber('0'), 0);
  assert.strictEqual(http.parseEpisodeNumber('1.5'), 1.5);
});

test('parseTypes v1 default', () => {
  const t = http.parseTypes(undefined, 1);
  assert.deepStrictEqual(t.sort(), ['ed', 'op']);
});

test('parseTypes v1 rejects mixed-op', () => {
  assert.throws(() => http.parseTypes(['op', 'mixed-op'], 1));
});

test('parseTypes v2 accepts all five', () => {
  const all = ['op', 'ed', 'mixed-op', 'mixed-ed', 'recap'];
  const got = http.parseTypes(all.join(','), 2).sort();
  assert.deepStrictEqual(got, [...all].sort());
});

test('parseTypes deduplicates', () => {
  assert.deepStrictEqual(http.parseTypes(['op', 'op', 'ed'], 1), ['op', 'ed']);
});

test('parseEpisodeLength defaults to 0', () => {
  assert.strictEqual(http.parseEpisodeLength(undefined), 0);
  assert.strictEqual(http.parseEpisodeLength('90.5'), 90.5);
  assert.strictEqual(http.parseEpisodeLength('-1'), 0);
});