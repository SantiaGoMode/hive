const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { braveWebSearch, BRAVE_WEB_SEARCH_URL } = require('../lib/braveSearchClient');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let liveBraveCalls = 0;

async function cappedLiveBraveSearch(query) {
  if (liveBraveCalls >= 2) throw new Error('Live Brave Search test cap exceeded');
  if (liveBraveCalls > 0) await sleep(1100);
  liveBraveCalls += 1;
  return braveWebSearch({
    query,
    apiKey: process.env.BRAVE_API_KEY,
    count: 2,
  });
}

describe('braveWebSearch', () => {
  it('calls Brave Search with the subscription token and maps web results', async () => {
    let seenUrl;
    let seenOpts;
    const out = await braveWebSearch({
      query: 'Hive local AI agents',
      apiKey: 'test-key',
      count: 2,
      fetchImpl: async (url, opts) => {
        seenUrl = url;
        seenOpts = opts;
        return {
          ok: true,
          json: async () => ({
            web: {
              results: [
                { title: 'Hive', url: 'https://example.com/hive', description: 'Local AI agent dashboard' },
              ],
            },
          }),
        };
      },
    });

    const parsed = new URL(seenUrl);
    assert.equal(`${parsed.origin}${parsed.pathname}`, BRAVE_WEB_SEARCH_URL);
    assert.equal(parsed.searchParams.get('q'), 'Hive local AI agents');
    assert.equal(parsed.searchParams.get('count'), '2');
    assert.equal(seenOpts.headers['X-Subscription-Token'], 'test-key');
    assert.deepEqual(out.results, [
      { title: 'Hive', url: 'https://example.com/hive', snippet: 'Local AI agent dashboard' },
    ]);
  });

  it('does not run the live Brave smoke test unless explicitly enabled', { skip: process.env.HIVE_LIVE_SEARCH_TESTS === '1' && process.env.BRAVE_API_KEY ? false : 'set BRAVE_API_KEY and HIVE_LIVE_SEARCH_TESTS=1 to run' }, async (t) => {
    try {
      const out = await cappedLiveBraveSearch('Brave Search API');
      assert.ok(Array.isArray(out.results));
      assert.ok(liveBraveCalls <= 2);
    } catch (err) {
      if (err.status === 429) {
        t.skip('Brave Search quota or rate limit reached; live smoke skipped without retrying');
        return;
      }
      throw err;
    }
  });
});
