// refresh-docs.mjs builds the docs copy from the site's source with the site's rules. This pins those rules on a small
// source, so a change to the code or to the pinned remark versions that would change the copy's text fails here.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildLlmsFull } from '../refresh-docs.mjs';

test('the docs copy is built from the source with the site rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'globalstack-docs-source-'));
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  try {
    write(
      'docs.json',
      JSON.stringify({
        navigation: {
          tabs: [
            { tab: 'Platform', groups: [{ group: 'Platform', pages: ['errors', 'api-reference/pagination'] }] },
            { tab: 'API Reference', openapi: 'api-reference/openapi.json' },
          ],
        },
      }),
    );
    write(
      'errors.mdx',
      [
        '---',
        'title: "Errors"',
        'description: "What each error code means."',
        '---',
        '',
        '## Bad request {#bad_request}',
        '',
        '**What to do** — Confirm the account_number and provider_id and retry.',
        '',
        '<Note className="callout" icon={icons.warning} title="Heads up">',
        '  Retry with the _same_ idempotency key.',
        '</Note>',
        '',
        '- one',
        '- two',
        '',
        '```bash',
        'curl https://api.globalstack.io/v1/me',
        '```',
        '',
      ].join('\n'),
    );
    write('api-reference/pagination.mdx', '---\ntitle: "Pagination"\n---\n\nLists take `page` and `per_page`.\n');
    write(
      'api-reference/openapi.json',
      JSON.stringify({
        paths: {
          '/v1/offramps': {
            parameters: [],
            get: { tags: ['Offramps'], summary: 'List offramps', description: 'Lists offramps, newest first.' },
          },
        },
      }),
    );

    // Sorted by URL, not by the navigation. Heading anchors, className and {expression} attributes are dropped; code
    // blocks get theme={null}; underscores in text are escaped; bullets and emphasis use *.
    assert.equal(
      buildLlmsFull(dir),
      [
        '# List offramps',
        'Source: https://docs.globalstack.io/api-reference/offramps/list-offramps',
        '',
        '/api-reference/openapi.json get /v1/offramps',
        'Lists offramps, newest first.',
        '',
        '',
        '',
        '# Pagination',
        'Source: https://docs.globalstack.io/api-reference/pagination',
        '',
        'Lists take `page` and `per_page`.',
        '',
        '',
        '# Errors',
        'Source: https://docs.globalstack.io/errors',
        '',
        'What each error code means.',
        '',
        '## Bad request',
        '',
        '**What to do** — Confirm the account\\_number and provider\\_id and retry.',
        '',
        '<Note title="Heads up">',
        '  Retry with the *same* idempotency key.',
        '</Note>',
        '',
        '* one',
        '* two',
        '',
        '```bash theme={null}',
        'curl https://api.globalstack.io/v1/me',
        '```',
        '',
        '',
        '',
      ].join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
