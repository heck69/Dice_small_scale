const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  INACTIVITY_TIMEOUT_MS,
  POST_TIMEOUT_WAIT_MS,
  WINDOW_DONE_TIMEOUT_MS,
  DEFAULT_DAILY_JOB_TARGET,
  canSenderSend,
  markSenderSent,
} = require('../lib/imessage-scheduler');

describe('iMessage Scheduler Timing Constants & Rate Limiter', () => {
  test('timing constants match 18m inactivity, 2m carrier pause, 27m window, 20 jobs/day', () => {
    assert.equal(INACTIVITY_TIMEOUT_MS, 18 * 60 * 1000, 'Inactivity timeout must be exactly 18 minutes');
    assert.equal(POST_TIMEOUT_WAIT_MS, 2 * 60 * 1000, 'Safety wait after timeout must be 2 minutes (T = 20m)');
    assert.equal(WINDOW_DONE_TIMEOUT_MS, 27 * 60 * 1000, 'Window done timeout must be 27 minutes');
    assert.equal(DEFAULT_DAILY_JOB_TARGET, 20, 'Default daily jobs target must be 20');
  });

  test('canSenderSend and markSenderSent enforces minimum 2-minute gap for idle contacts', () => {
    const testSender = 'snd_test_rate_limit_123';
    
    // Initially can send
    assert.equal(canSenderSend(testSender), true);

    // After sending, cannot send immediately
    markSenderSent(testSender);
    assert.equal(canSenderSend(testSender), false);
  });
});
