const STOP_WORDS = new Set([
  'a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with',
]);

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(value) {
  return new Set(
    normalizeText(value)
      .split(/\s+/)
      .filter((token) => token && !STOP_WORDS.has(token))
  );
}

function roleMatchesJobTitle(jobTitle, roles, threshold = 0.75) {
  const jobTokens = tokens(jobTitle);
  if (!jobTokens.size) return false;

  return (Array.isArray(roles) ? roles : [roles]).filter(Boolean).some((role) => {
    const roleTokens = tokens(role);
    if (!roleTokens.size) return false;

    let overlap = 0;
    for (const token of roleTokens) {
      if (jobTokens.has(token)) overlap += 1;
    }

    const containment = overlap / Math.min(jobTokens.size, roleTokens.size);
    const jaccard = overlap / (jobTokens.size + roleTokens.size - overlap);
    return Math.max(containment, jaccard * 1.25) >= threshold;
  });
}

function companyIsExcluded(company, excludedCompanies) {
  const normalizedCompany = normalizeText(company);
  if (!normalizedCompany) return false;

  const exclusions = Array.isArray(excludedCompanies)
    ? excludedCompanies
    : String(excludedCompanies || '').split(/[,;|]/);

  return exclusions.some((excluded) => {
    const normalizedExcluded = normalizeText(excluded);
    return normalizedExcluded
      && (normalizedCompany === normalizedExcluded
        || normalizedCompany.includes(normalizedExcluded)
        || normalizedExcluded.includes(normalizedCompany));
  });
}

function jobMatchesProfile(job, profile) {
  const alternateRoles = Array.isArray(profile?.alternate_job_roles)
    ? profile.alternate_job_roles
    : String(profile?.alternate_job_roles || '').split(/[,;|]/);
  const roles = [profile?.role, ...alternateRoles];

  return roleMatchesJobTitle(job.title, roles)
    && !companyIsExcluded(job.company, profile?.exclude_companies);
}

module.exports = {
  companyIsExcluded,
  jobMatchesProfile,
  normalizeText,
  roleMatchesJobTitle,
};