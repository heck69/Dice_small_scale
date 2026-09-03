const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { normalizePhone } = require('../lib/bluebubbles');
const { createWebhookServer } = require('../lib/webhook-server');

describe('BlueBubbles Phone Normalization', () => {
  test('normalizes standard US 10-digit phone', () => {
    assert.equal(normalizePhone('5551234567'), '+15551234567');
  });

  test('normalizes formatted US phone with parentheses and dashes', () => {
    assert.equal(normalizePhone('+1 (555) 123-4567'), '+15551234567');
    assert.equal(normalizePhone('1-555-123-4567'), '+15551234567');
  });

  test('normalizes Indian phone numbers (+91, 91..., and 0...)', () => {
    assert.equal(normalizePhone('+91 98765 43210'), '+919876543210');
    assert.equal(normalizePhone('919876543210'), '+919876543210');
    assert.equal(normalizePhone('09876543210'), '+919876543210');
    assert.equal(normalizePhone('+91-9876543210'), '+919876543210');
  });

  test('normalizes 10-digit number with Indian default country code', () => {
    assert.equal(normalizePhone('9876543210', '91'), '+919876543210');
  });

  test('preserves valid international E.164 numbers', () => {
    assert.equal(normalizePhone('+447911123456'), '+447911123456');
    assert.equal(normalizePhone('+919876543210'), '+919876543210');
  });

  test('returns null for invalid or empty numbers', () => {
    assert.equal(normalizePhone(''), null);
    assert.equal(normalizePhone('+'), null);
    assert.equal(normalizePhone('123'), null);
    assert.equal(normalizePhone(null), null);
    assert.equal(normalizePhone(undefined), null);
  });
});

describe('Webhook Server Security & Deduplication', () => {
  const TEST_PORT = 3999;
  const SECRET = 'test-secret-token-123';
  let server;
  let receivedMessages = [];

  test('starts webhook server', async () => {
    server = createWebhookServer({
      port: TEST_PORT,
      secretToken: SECRET,
      onNewMessage: async (msg) => {
        receivedMessages.push(msg);
      },
    });
    assert.ok(server);
  });

  function postJson(path, payload, headers = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: TEST_PORT,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            ...headers,
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  test('rejects unauthorized request without secret (401)', async () => {
    const res = await postJson('/webhook', { event: 'new-message' });
    assert.equal(res.status, 401);
  });

  test('accepts authorized request with query secret (200)', async () => {
    const payload = {
      event: 'new-message',
      data: {
        messageGuid: 'guid-001',
        isFromMe: false,
        text: 'yes',
        handle: { address: '+15551234567' },
      },
    };
    const res = await postJson(`/webhook?secret=${SECRET}`, payload);
    assert.equal(res.status, 200);

    // Wait a brief moment for async dispatch
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(receivedMessages.length, 1);
    assert.equal(receivedMessages[0].phoneHandle, '+15551234567');
    assert.equal(receivedMessages[0].text, 'yes');
  });

  test('deduplicates identical messageGuid within TTL', async () => {
    const payload = {
      event: 'new-message',
      data: {
        messageGuid: 'guid-001', // Same GUID as previous test
        isFromMe: false,
        text: 'yes',
        handle: { address: '+15551234567' },
      },
    };
    const res = await postJson(`/webhook?secret=${SECRET}`, payload);
    assert.equal(res.status, 200);

    await new Promise((r) => setTimeout(r, 50));
    // Count should still be 1 because duplicate GUID was dropped
    assert.equal(receivedMessages.length, 1);
  });

  test('extracts phone number from chatGuid fallback if handle.address is missing', async () => {
    const payload = {
      event: 'new-message',
      data: {
        messageGuid: 'guid-002',
        isFromMe: false,
        text: 'no',
        chatGuid: 'iMessage;-;+15559876543',
      },
    };
    const res = await postJson(`/webhook?secret=${SECRET}`, payload);
    assert.equal(res.status, 200);

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(receivedMessages.length, 2);
    assert.equal(receivedMessages[1].phoneHandle, '+15559876543');
    assert.equal(receivedMessages[1].text, 'no');
  });

  test('cleans up test server', () => {
    if (server) server.close();
  });
});
