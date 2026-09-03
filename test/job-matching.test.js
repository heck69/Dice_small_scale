const test = require('node:test');
const assert = require('node:assert/strict');
const { companyIsExcluded, jobMatchesProfile, roleMatchesJobTitle } = require('../lib/job-matching');

test('matches close job titles against primary or alternate roles', () => {
  assert.equal(roleMatchesJobTitle('Senior Backend Software Engineer', ['Software Engineer']), true);
  assert.equal(roleMatchesJobTitle('Graphic Designer', ['Software Engineer', 'Backend Developer']), false);
  assert.equal(jobMatchesProfile(
    { title: 'Senior Backend Software Engineer', company: 'Acme Labs' },
    { role: 'Software Engineer', alternate_job_roles: ['Backend Developer'], exclude_companies: [] }
  ), true);
});

test('rejects excluded companies case-insensitively', () => {
  assert.equal(companyIsExcluded('Acme Labs, Inc.', ['acme labs']), true);
  assert.equal(jobMatchesProfile(
    { title: 'Software Engineer', company: 'Acme Labs' },
    { role: 'Software Engineer', alternate_job_roles: [], exclude_companies: ['ACME LABS'] }
  ), false);
});
