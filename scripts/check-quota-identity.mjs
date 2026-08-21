// Self-check for the quota-identity helpers in src/db.ts (run: npm run build:server && node scripts/check-quota-identity.mjs).
// Asserts that trivial email variants collapse to one tombstone — the property
// that stops delete/re-signup cycles from resetting the free-tier quota.
import assert from 'node:assert/strict'

// db.ts pulls config.ts, which zod-validates env at import time. Stub the
// required vars; nothing here ever opens a connection.
const stubs = {
  MCP_SERVER_URL: 'https://example.test/mcp',
  OPENAI_API_KEY: 'x',
  BETTER_AUTH_URL: 'https://example.test',
  BETTER_AUTH_SECRET: 'x',
  DATABASE_URL: 'postgres://stub',
  BUCKET_NAME: 'stub',
  BUCKET_ACCESS_KEY_ID: 'x',
  BUCKET_SECRET_ACCESS_KEY: 'x',
}
for (const [k, v] of Object.entries(stubs)) process.env[k] ??= v

const { normalizeEmail, usageTombstoneId } = await import('../dist/db.js')

assert.equal(normalizeEmail('  Foo.Bar+spam@GMail.com '), 'foobar@gmail.com')
assert.equal(normalizeEmail('foo.bar@googlemail.com'), 'foobar@googlemail.com')
// Dots are significant outside the gmail family; +tags never are.
assert.equal(normalizeEmail('Foo.Bar+x@Example.com'), 'foo.bar@example.com')

const id = usageTombstoneId('foo.bar+a@gmail.com')
assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
// All variants of one mailbox share a tombstone; different mailboxes don't.
assert.equal(id, usageTombstoneId('FOOBAR@gmail.com'))
assert.notEqual(id, usageTombstoneId('foobar@example.com'))

console.log('quota-identity self-check passed')
