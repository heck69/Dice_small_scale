const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createWebhookApp } = require('../lib/webhook-server');

describe('LoopMessage Webhook Server & Ingress', () => {
  let server;
  let baseUrl;
  const mockSecret = 'test_webhook_secret_9988';
  let enqueuedJobs = [];
  let insertedApplications = [];

  before(async () => {
    process.env.LOOPMESSAGE_WEBHOOK_SECRET = mockSecret;

    const createChain = () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        ilike: () => chain,
        or: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({
          data: {
            id: 'client-uuid-123',
            name: 'Jane Doe',
            company_email: 'jane@icloud.com',
            callable_phone: '+13235550199',
            client_id: 'client-uuid-123',
            is_opted_in: true,
            job_url: 'https://www.dice.com/job/sample-123',
            job_name: 'Senior Developer',
            status: 'offered',
          },
        }),
        single: async () => ({ data: { id: 'test-id' } }),
        insert: async (row) => {
          insertedApplications.push(row);
          return { data: row };
        },
        upsert: async () => ({ data: null }),
        update: () => chain,
      };
      return chain;
    };

    const mockSupabase = {
      from: () => createChain(),
    };

    const mockQueue = {
      enqueueApplyJob: async (job) => {
        enqueuedJobs.push(job);
        return { id: 'mock-job-id' };
      },
    };

    const app = createWebhookApp(mockSupabase, mockQueue);
    server = http.createServer(app);

    await new Promise((resolve) => {
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    delete process.env.LOOPMESSAGE_WEBHOOK_SECRET;
    await new Promise((resolve) => server.close(resolve));
  });

  test('GET /health returns status ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });

  test('POST /webhook/loopmessage rejects request with invalid secret (401)', async () => {
    const res = await fetch(`${baseUrl}/webhook/loopmessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'wrong_secret',
      },
      body: JSON.stringify({ event: 'message_inbound', text: 'START', contact: '+13235550199' }),
    });

    assert.equal(res.status, 401);
  });

  test('POST /webhook/loopmessage returns HTTP 200 fast and processes START with email handle', async () => {
    const startTime = Date.now();
    const res = await fetch(`${baseUrl}/webhook/loopmessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: mockSecret,
      },
      body: JSON.stringify({
        event: 'message_inbound',
        text: 'START',
        contact: 'jane@icloud.com',
        message_id: 'msg_start_email_001',
      }),
    });

    const elapsed = Date.now() - startTime;
    assert.equal(res.status, 200);
    assert.ok(elapsed < 200, `Fast ACK required, took ${elapsed}ms`);
  });

  test('POST /webhook/loopmessage handles YES reply and enqueues job', async () => {
    enqueuedJobs = [];
    const res = await fetch(`${baseUrl}/webhook/loopmessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: mockSecret,
      },
      body: JSON.stringify({
        event: 'message_inbound',
        text: 'YES',
        contact: '+13235550199',
        message_id: 'msg_yes_001',
      }),
    });

    assert.equal(res.status, 200);
    // Allow small async loop delay
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(enqueuedJobs.length, 1);
    assert.equal(enqueuedJobs[0].clientId, 'client-uuid-123');
    assert.equal(enqueuedJobs[0].channel, 'imessage');
  });

  test('POST /webhook/loopmessage handles Apple Tapback (like reaction) as YES', async () => {
    enqueuedJobs = [];
    const res = await fetch(`${baseUrl}/webhook/loopmessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: mockSecret,
      },
      body: JSON.stringify({
        event: 'message_reaction',
        reaction: 'like',
        contact: '+13235550199',
        message_id: 'msg_reaction_like_001',
      }),
    });

    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(enqueuedJobs.length, 1);
  });

  test('POST /webhook/loopmessage handles NO reply and records rejection', async () => {
    insertedApplications = [];
    const res = await fetch(`${baseUrl}/webhook/loopmessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: mockSecret,
      },
      body: JSON.stringify({
        event: 'message_inbound',
        text: 'NO',
        contact: '+13235550199',
        message_id: 'msg_no_001',
      }),
    });

    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(insertedApplications.length, 1);
    assert.equal(insertedApplications[0].status, 'rejected');
  });

  test('POST /webhook/loopmessage handles STOP and pauses alerts', async () => {
    const res = await fetch(`${baseUrl}/webhook/loopmessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: mockSecret,
      },
      body: JSON.stringify({
        event: 'message_inbound',
        text: 'STOP',
        contact: '+13235550199',
        message_id: 'msg_stop_001',
      }),
    });

    assert.equal(res.status, 200);
  });
});
