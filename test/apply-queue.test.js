const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplyQueue } = require('../lib/apply-queue');

test('hasActiveClientJob detects queued or running work for the same client', async () => {
  const supabase = {
    from(table) {
      assert.equal(table, 'apply_queue');
      return {
        select() {
          return {
            eq() {
              return {
                in() {
                  return {
                    maybeSingle: async () => ({
                      data: { id: 101, status: 'queued' },
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  const queue = createApplyQueue(supabase);
  const active = await queue.hasActiveClientJob(42);
  assert.equal(active, true);
});
