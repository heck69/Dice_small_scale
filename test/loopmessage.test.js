const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  isEmailHandle,
  normalizePhone,
  parseContactHandle,
} = require('../lib/loopmessage');

describe('LoopMessage Contact Handle Normalization', () => {
  test('isEmailHandle correctly detects email addresses', () => {
    assert.equal(isEmailHandle('user@icloud.com'), true);
    assert.equal(isEmailHandle('john.doe+work@gmail.com'), true);
    assert.equal(isEmailHandle('+13235550199'), false);
    assert.equal(isEmailHandle('notanemail'), false);
    assert.equal(isEmailHandle(''), false);
    assert.equal(isEmailHandle(null), false);
  });

  test('normalizePhone normalizes 10-digit US numbers to E.164', () => {
    assert.equal(normalizePhone('3235550199'), '+13235550199');
    assert.equal(normalizePhone('(323) 555-0199'), '+13235550199');
    assert.equal(normalizePhone('323-555-0199'), '+13235550199');
  });

  test('normalizePhone preserves international phone numbers', () => {
    assert.equal(normalizePhone('+919876543210'), '+919876543210');
    assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
    assert.equal(normalizePhone('13235550199'), '+13235550199');
  });

  test('parseContactHandle correctly classifies phone and email handles', () => {
    const emailResult = parseContactHandle('John.Doe@iCloud.com');
    assert.deepEqual(emailResult, {
      type: 'email',
      handle: 'john.doe@icloud.com',
    });

    const phoneResult = parseContactHandle('(323) 555-0199');
    assert.deepEqual(phoneResult, {
      type: 'phone',
      handle: '+13235550199',
    });

    const invalidResult = parseContactHandle('invalid');
    assert.equal(invalidResult, null);
  });
});
