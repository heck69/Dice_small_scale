const crypto = require('crypto');

function asText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function asUuid(value) {
  const text = asText(value);
  if (!text || text === '-') return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null;
}

function asDate(value) {
  const text = asText(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function asTimestamptz(value) {
  const text = asText(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asBoolean(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', 'yes', '1'].includes(text)) return true;
  if (['false', 'no', '0'].includes(text)) return false;
  return null;
}

function asInteger(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function asTextArray(value) {
  if (value == null || value === '') return null;
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).trim()).filter(Boolean);
    return items.length ? items : null;
  }
  return null;
}

function parseExcludeCompanies(value) {
  if (value == null || value === '') return { parsed: null, raw: null };
  if (Array.isArray(value)) {
    const parsed = value.flatMap((item) => String(item).split(',').map((part) => part.trim()).filter(Boolean));
    return { parsed: parsed.length ? parsed : null, raw: JSON.stringify(value) };
  }

  const raw = String(value);
  try {
    const parsedJson = JSON.parse(raw);
    if (Array.isArray(parsedJson)) {
      const parsed = parsedJson.flatMap((item) => String(item).split(',').map((part) => part.trim()).filter(Boolean));
      return { parsed: parsed.length ? parsed : null, raw };
    }
  } catch {
    // keep raw string
  }

  const parsed = raw.split(',').map((part) => part.replace(/[[\]"]/g, '').trim()).filter(Boolean);
  return { parsed: parsed.length ? parsed : null, raw };
}

function unwrapRecord(item) {
  if (!item || typeof item !== 'object') return { client: null, additional: null };
  if (item.client) {
    return { client: item.client, additional: item.additional_information || null };
  }
  return { client: item, additional: item.additional_information || null };
}

function mapClientRow(client) {
  const companyEmail = asText(client.company_email);
  const applywizzId = asText(client.applywizz_id);
  if (!companyEmail || !applywizzId) {
    throw new Error('client is missing company_email or applywizz_id');
  }

  return {
    id: asUuid(client.id) || crypto.randomUUID(),
    applywizz_id: applywizzId,
    full_name: asText(client.full_name || client.name),
    personal_email: asText(client.personal_email),
    company_email: companyEmail,
    whatsapp_number: asText(client.whatsapp_number),
    callable_phone: asText(client.callable_phone || client.phone),
    job_role_preferences: asTextArray(client.job_role_preferences),
    salary_range: asText(client.salary_range),
    location_preferences: asTextArray(client.location_preferences),
    work_auth_details: asText(client.work_auth_details),
    account_manager_id: asUuid(client.account_manager_id),
    onboarded_by: asUuid(client.onboarded_by),
    career_associate_id: asUuid(client.careerassociateid || client.career_associate_id),
    scraper_id: asUuid(client.scraperid || client.scraper_id),
    career_associate_manager_id: asUuid(client.careerassociatemanagerid || client.career_associate_manager_id),
    client_office_id: asText(client.clientofficeid || client.client_office_id),
    onboarding_date: asDate(client.onboardingdate || client.onboarding_date),
    visa_type: asText(client.visa_type),
    sponsorship: asBoolean(client.sponsorship),
    badge_value: asInteger(client.badge_value),
    coding_labs: asBoolean(client.coding_labs),
    coding_lab_url: asText(client.coding_lab_url),
    opted_job_links: asBoolean(client.opted_job_links),
    lab_id_1: asUuid(client.lab_id_1),
    lab_id_2: asUuid(client.lab_id_2),
    mcq_results: client.mcq_results ?? null,
    test_results: client.test_results ?? null,
    status: asText(client.status),
    role_last_updated: asTimestamptz(client.role_last_updated),
    crm_created_at: asTimestamptz(client.created_at),
    crm_updated_at: asTimestamptz(client.update_at || client.updated_at),
    imported_at: new Date().toISOString(),
    raw_payload: client,
  };
}

function mapProfileRow(clientId, applywizzId, additional) {
  if (!additional || typeof additional !== 'object') return null;
  const exclude = parseExcludeCompanies(additional.exclude_companies);

  return {
    id: asUuid(additional.id) || clientId,
    applywizz_id: asText(additional.applywizz_id) || applywizzId,
    resume_url: asText(additional.resume_url),
    resume_path: asText(additional.resume_path),
    cover_letter_path: asText(additional.cover_letter_path),
    google_drive_resume_link: asText(additional.google_drive_resume_link),
    start_date: asDate(additional.start_date),
    end_date: asDate(additional.end_date),
    no_of_applications: asInteger(additional.no_of_applications),
    is_over_18: asBoolean(additional.is_over_18),
    eligible_to_work_in_us: asBoolean(additional.eligible_to_work_in_us),
    authorized_without_visa: asBoolean(additional.authorized_without_visa),
    require_future_sponsorship: asBoolean(additional.require_future_sponsorship),
    can_perform_essential_functions: asBoolean(additional.can_perform_essential_functions),
    worked_for_company_before: asBoolean(additional.worked_for_company_before),
    discharged_for_policy_violation: asBoolean(additional.discharged_for_policy_violation),
    referred_by_agency: asBoolean(additional.referred_by_agency),
    highest_education: asText(additional.highest_education),
    university_name: asText(additional.university_name),
    cumulative_gpa: asText(additional.cumulative_gpa),
    desired_start_date: asDate(additional.desired_start_date),
    willing_to_relocate: asBoolean(additional.willing_to_relocate),
    can_work_3_days_in_office: asBoolean(additional.can_work_3_days_in_office),
    role: asText(additional.role),
    experience: additional.experience == null ? null : String(additional.experience),
    work_preferences: asText(additional.work_preferences),
    alternate_job_roles: asText(additional.alternate_job_roles),
    exclude_companies: exclude.parsed,
    exclude_companies_raw: exclude.raw,
    convicted_of_felony: asBoolean(additional.convicted_of_felony),
    felony_explanation: asText(additional.felony_explanation),
    pending_investigation: asBoolean(additional.pending_investigation),
    willing_background_check: asBoolean(additional.willing_background_check),
    willing_drug_screen: asBoolean(additional.willing_drug_screen),
    failed_or_refused_drug_test: asBoolean(additional.failed_or_refused_drug_test),
    uses_substances_affecting_duties: asBoolean(additional.uses_substances_affecting_duties),
    substances_description: asText(additional.substances_description),
    can_provide_legal_docs: asBoolean(additional.can_provide_legal_docs),
    gender: asText(additional.gender),
    is_hispanic_latino: asText(additional.is_hispanic_latino),
    race_ethnicity: asText(additional.race_ethnicity),
    veteran_status: asText(additional.veteran_status),
    disability_status: asText(additional.disability_status),
    has_relatives_in_company: asBoolean(additional.has_relatives_in_company),
    relatives_details: asText(additional.relatives_details),
    state_of_residence: asText(additional.state_of_residence),
    zip_or_country: asText(additional.zip_or_country),
    full_address: asText(additional.full_address),
    date_of_birth: asDate(additional.date_of_birth),
    primary_phone: asText(additional.primary_phone),
    main_subject: asText(additional.main_subject),
    graduation_year: additional.graduation_year == null ? null : String(additional.graduation_year),
    add_ons_info: asTextArray(additional.add_ons_info),
    github_url: asText(additional.github_url),
    linked_in_url: asText(additional.linked_in_url),
    client_form_fill_date: asTimestamptz(additional.client_form_fill_date),
    working_status: asText(additional.working_status),
    crm_created_at: asTimestamptz(additional.created_at),
    crm_updated_at: asTimestamptz(additional.updated_at),
    raw_payload: additional,
  };
}

function mapImportItem(item) {
  const { client, additional } = unwrapRecord(item);
  if (!client) throw new Error('record is missing client data');
  const clientRow = mapClientRow(client);
  const profileRow = mapProfileRow(clientRow.id, clientRow.applywizz_id, additional);
  return { clientRow, profileRow };
}

module.exports = {
  mapImportItem,
};
