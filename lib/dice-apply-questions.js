function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function yesNoFromBoolean(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return null;
}

function pickAllOptions(options, wantedList) {
  const chosen = [];
  for (const wanted of wantedList) {
    const match = pickOption(options, wanted);
    if (match && !chosen.includes(match)) chosen.push(match);
  }
  return chosen;
}

function answersToList(answer) {
  if (answer == null || answer === '') return [];
  if (Array.isArray(answer)) return answer.map((item) => String(item).trim()).filter(Boolean);
  return String(answer).split(',').map((item) => item.trim()).filter(Boolean);
}

function ruleAnswerMulti(question, options, profile) {
  const single = ruleAnswer(question, options, profile);
  if (single) return answersToList(single);

  const roleHints = [
    ...(Array.isArray(profile.job_role_preferences) ? profile.job_role_preferences : []),
    ...answersToList(profile.alternate_job_roles),
    ...(Array.isArray(profile.add_ons_info) ? profile.add_ons_info : []),
  ];
  const fromProfile = pickAllOptions(options, roleHints);
  return fromProfile.length ? fromProfile : null;
}

function pickOption(options, wanted) {
  if (!wanted) return null;
  const wantedLower = String(wanted).trim().toLowerCase();
  return options.find((option) => option.toLowerCase() === wantedLower)
    || options.find((option) => option.toLowerCase().includes(wantedLower))
    || null;
}

async function answerWithLlm(/* { question, options, type, profile } */) {
  console.log('[LLM placeholder] No API configured; unmatched question will not be auto-answered.');
  return { skip: true };
}

function ruleAnswer(question, options, profile) {
  const q = question.toLowerCase();
  const pickYesNo = (bool) => pickOption(options, yesNoFromBoolean(bool));

  if (/office|on-site|onsite|come into the office|in the office|on site/.test(q)) {
    return pickYesNo(profile.can_work_3_days_in_office);
  }
  if (/relocat/.test(q)) {
    return pickYesNo(profile.willing_to_relocate);
  }
  if (/sponsor/.test(q)) {
    return pickYesNo(profile.require_future_sponsorship ?? profile.sponsorship);
  }
  if (/over 18|18 years/.test(q)) {
    return pickYesNo(profile.is_over_18);
  }
  if (/eligible to work in the (united states|u\.?s\.?)/.test(q) || /authorized to work in the (united states|u\.?s\.?)/.test(q)) {
    return pickYesNo(profile.eligible_to_work_in_us);
  }
  if (/authorized without (a )?visa|without visa sponsorship/.test(q)) {
    return pickYesNo(profile.authorized_without_visa);
  }
  if (/background check/.test(q)) {
    return pickYesNo(profile.willing_background_check);
  }
  if (/drug (screen|test)/.test(q)) {
    return pickYesNo(profile.willing_drug_screen);
  }
  if (/felony|convicted/.test(q)) {
    return pickYesNo(profile.convicted_of_felony);
  }
  if (/perform essential functions|essential (job )?functions/.test(q)) {
    return pickYesNo(profile.can_perform_essential_functions);
  }
  if (/years of experience|how many years/.test(q) && options.length === 0) {
    return profile.experience ? String(profile.experience) : null;
  }
  if (/highest (level of )?education|education level/.test(q)) {
    return pickOption(options, profile.highest_education) || (options.length ? null : profile.highest_education);
  }
  if (/when can you start|start date/.test(q) && options.length === 0) {
    return profile.desired_start_date ? String(profile.desired_start_date) : null;
  }

  return null;
}

async function loadApplyProfile(supabase, clientId) {
  if (!clientId) return {};

  const { data: client, error: clientError } = await supabase
    .from('clients')
    .select('full_name, visa_type, sponsorship, job_role_preferences, applywizz_id, company_email')
    .eq('id', clientId)
    .maybeSingle();
  if (clientError) console.error('Failed to load client for apply questions:', clientError.message);

  const { data: profile, error: profileError } = await supabase
    .from('client_profiles')
    .select('can_work_3_days_in_office, willing_to_relocate, require_future_sponsorship, is_over_18, eligible_to_work_in_us, authorized_without_visa, willing_background_check, willing_drug_screen, convicted_of_felony, can_perform_essential_functions, experience, highest_education, desired_start_date, resume_url, add_ons_info, role, alternate_job_roles, exclude_companies')
    .eq('id', clientId)
    .maybeSingle();
  if (profileError) console.error('Failed to load profile for apply questions:', profileError.message);

  return {
    ...(client || {}),
    ...(profile || {}),
    sponsorship: client?.sponsorship,
  };
}

async function isResumeCoverStep(page) {
  const heading = page.getByText(/resume\s*&\s*cover letter/i);
  return (await heading.count()) > 0;
}

async function radioGroupAlreadyAnswered(group) {
  const radios = group.locator('input[type="radio"]');
  const count = await radios.count();
  for (let i = 0; i < count; i += 1) {
    if (await radios.nth(i).isChecked().catch(() => false)) return true;
  }
  return false;
}

async function readRadioQuestion(group) {
  const slotLabel = normalizeText(await group.locator('[slot="label"]').first().innerText().catch(() => ''));
  if (slotLabel) return slotLabel;

  const labelledBy = await group.getAttribute('aria-labelledby');
  if (labelledBy) {
    const id = labelledBy.trim().split(/\s+/)[0];
    const fromId = normalizeText(await group.page().locator(`[id="${id}"]`).innerText().catch(() => ''));
    if (fromId) return fromId;
  }

  return normalizeText(await group.getAttribute('aria-label') || '');
}

async function optionLabelsFromGroup(group) {
  const labels = group.locator('label');
  const count = await labels.count();
  const options = [];
  for (let i = 0; i < count; i += 1) {
    const text = normalizeText(await labels.nth(i).innerText().catch(() => ''));
    if (text) options.push(text);
  }
  return options;
}

async function clickLabeledControl(group, optionText) {
  const exact = new RegExp(`^${escapeRegExp(optionText)}$`, 'i');
  const pressableExact = group.locator('label[data-react-aria-pressable="true"]').filter({ hasText: exact });
  const pressableLoose = group.locator('label[data-react-aria-pressable="true"]').filter({ hasText: optionText });
  const labelExact = group.locator('label').filter({ hasText: exact });
  const byText = group.getByText(optionText, { exact: true });

  let target = pressableExact;
  if (await target.count() === 0) target = pressableLoose;
  if (await target.count() === 0) target = labelExact;
  if (await target.count() === 0) target = byText;

  await target.first().scrollIntoViewIfNeeded();
  await target.first().click();
}

function applyQuestionForm(page) {
  const withStepButton = page.locator('form').filter({
    has: page.getByRole('button', { name: /^(next|submit)$/i }),
  });
  return withStepButton.last();
}

async function fillRadioGroups(page, profile) {
  const form = applyQuestionForm(page);
  await form.getByRole('radiogroup').first().waitFor({ state: 'attached', timeout: 4000 }).catch(() => { });

  let groups = form.getByRole('radiogroup');
  let count = await groups.count();
  if (count === 0) {
    groups = form.locator('[role="radiogroup"]');
    count = await groups.count();
  }

  const rawRadios = await form.locator('input[type="radio"]').count();
  console.log('[apply-questions] radio scan', {
    inForm: (await form.count()) > 0,
    radiogroups: count,
    rawRadioInputs: rawRadios,
    officeDb: profile.can_work_3_days_in_office ?? null,
    relocateDb: profile.willing_to_relocate ?? null,
    sponsorshipDb: profile.require_future_sponsorship ?? profile.sponsorship ?? null,
  });

  for (let i = 0; i < count; i += 1) {
    const group = groups.nth(i);
    const already = await radioGroupAlreadyAnswered(group);
    const question = await readRadioQuestion(group);
    const options = await optionLabelsFromGroup(group);

    console.log('[apply-questions] radio group', {
      index: i,
      question: question || '(empty)',
      options,
      alreadyAnswered: already,
    });

    if (already) continue;
    if (!question || options.length === 0) {
      return { ok: false, reason: `Found a radio group but could not read question/options (question="${question}")` };
    }

    const answer = ruleAnswer(question, options, profile);
    console.log('[apply-questions] DB rule result', { question, answer: answer || '(no rule match)' });

    let chosen = answer;
    if (!chosen) {
      const llm = await answerWithLlm({ question, options, type: 'radio', profile });
      console.log('[apply-questions] LLM placeholder', llm);
      if (llm?.skip || !llm?.answer) {
        return { ok: false, reason: `Unanswered radio: ${question}` };
      }
      chosen = llm.answer;
    }

    const option = pickOption(options, chosen);
    if (!option) {
      return { ok: false, reason: `No matching radio option for: ${question}` };
    }
    console.log('[apply-questions] clicking radio', option);
    await clickLabeledControl(group, option);
  }

  return { ok: true };
}

async function optionIsSelected(group, optionText) {
  const exact = new RegExp(`^${escapeRegExp(optionText)}$`, 'i');
  const label = group.locator('label').filter({ hasText: exact }).first();
  if (await label.getAttribute('data-selected').catch(() => null) === 'true') return true;
  return label.locator('input[type="checkbox"]').isChecked().catch(() => false);
}

async function collectCheckboxGroups(form) {
  const byRole = form.locator('[role="group"]').filter({ has: form.locator('input[type="checkbox"]') });
  const roleCount = await byRole.count();
  if (roleCount > 0) {
    const groups = [];
    for (let i = 0; i < roleCount; i += 1) groups.push(byRole.nth(i));
    return groups;
  }

  const boxes = form.locator('input[type="checkbox"]');
  const boxCount = await boxes.count();
  const seen = new Set();
  const groups = [];
  for (let i = 0; i < boxCount; i += 1) {
    const name = (await boxes.nth(i).getAttribute('name')) || `__idx_${i}`;
    if (seen.has(name)) continue;
    seen.add(name);
    const first = boxes.nth(i);
    const ancestor = first.locator('xpath=ancestor::*[.//*[@slot="label"]][1]');
    groups.push((await ancestor.count()) ? ancestor : first.locator('xpath=ancestor::div[1]'));
  }
  return groups;
}

async function fillCheckboxGroups(page, profile) {
  const form = applyQuestionForm(page);
  await form.locator('input[type="checkbox"]').first().waitFor({ state: 'attached', timeout: 2000 }).catch(() => { });

  const groups = await collectCheckboxGroups(form);
  const rawBoxes = await form.locator('input[type="checkbox"]').count();
  console.log('[apply-questions] checkbox scan', {
    inForm: (await form.count()) > 0,
    checkboxGroups: groups.length,
    rawCheckboxInputs: rawBoxes,
    rolesDb: profile.job_role_preferences ?? null,
    alternateRolesDb: profile.alternate_job_roles ?? null,
  });

  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const question = await readRadioQuestion(group);
    const options = await optionLabelsFromGroup(group);

    console.log('[apply-questions] checkbox group', {
      index: i,
      question: question || '(empty)',
      options,
    });

    if (!question || options.length === 0) {
      return { ok: false, reason: `Found a checkbox group but could not read question/options (question="${question}")` };
    }

    const answer = ruleAnswerMulti(question, options, profile);
    console.log('[apply-questions] DB rule result', { question, answer: answer || '(no rule match)' });

    let chosenList = answer;
    if (!chosenList || !chosenList.length) {
      const llm = await answerWithLlm({ question, options, type: 'checkbox', profile });
      console.log('[apply-questions] LLM placeholder', llm);
      if (llm?.skip || llm?.answer == null) {
        return { ok: false, reason: `Unanswered checkbox: ${question}` };
      }
      chosenList = answersToList(llm.answer);
    }

    const toClick = pickAllOptions(options, chosenList);
    if (!toClick.length) {
      return { ok: false, reason: `No matching checkbox options for: ${question}` };
    }

    for (const option of toClick) {
      if (await optionIsSelected(group, option)) {
        console.log('[apply-questions] checkbox already selected', option);
        continue;
      }
      console.log('[apply-questions] clicking checkbox', option);
      await clickLabeledControl(group, option);
    }
  }

  return { ok: true };
}

function looksLikeCoverLetter(text) {
  return /cover letter/i.test(text);
}

async function readTextQuestion(field) {
  const container = field.locator('xpath=ancestor::*[.//*[@slot="label"]][1]');
  const slotLabel = normalizeText(await container.locator('[slot="label"]').first().innerText().catch(() => ''));
  if (slotLabel) return slotLabel;

  const labelledBy = await field.getAttribute('aria-labelledby');
  if (labelledBy) {
    const id = labelledBy.trim().split(/\s+/)[0];
    const fromId = normalizeText(await field.page().locator(`[id="${id}"]`).innerText().catch(() => ''));
    if (fromId) return fromId;
  }

  return normalizeText(await field.getAttribute('aria-label') || await field.getAttribute('placeholder') || '');
}

async function fillTextFields(page, profile) {
  const form = applyQuestionForm(page);
  await form.locator('textarea, input[type="text"]').first().waitFor({ state: 'attached', timeout: 2000 }).catch(() => { });

  const fields = form.locator('textarea, input[type="text"]');
  const count = await fields.count();
  console.log('[apply-questions] text scan', {
    inForm: (await form.count()) > 0,
    textFields: count,
    experienceDb: profile.experience ?? null,
    startDateDb: profile.desired_start_date ?? null,
  });

  for (let i = 0; i < count; i += 1) {
    const field = fields.nth(i);
    if (!await field.isVisible().catch(() => false)) continue;
    const current = normalizeText(await field.inputValue().catch(() => ''));
    const question = await readTextQuestion(field);

    console.log('[apply-questions] text field', {
      index: i,
      question: question || '(empty)',
      alreadyFilled: Boolean(current),
    });

    if (current) continue;
    if (looksLikeCoverLetter(question)) continue;
    if (!question) {
      return { ok: false, reason: 'Found a text field but could not read its question' };
    }

    const answer = ruleAnswer(question, [], profile);
    console.log('[apply-questions] DB rule result', { question, answer: answer || '(no rule match)' });

    let chosen = answer;
    if (!chosen) {
      const llm = await answerWithLlm({ question, options: [], type: 'text', profile });
      console.log('[apply-questions] LLM placeholder', llm);
      if (llm?.skip || !llm?.answer) {
        const required = /required|\*/i.test(question);
        if (required) return { ok: false, reason: `Unanswered text: ${question}` };
        continue;
      }
      chosen = llm.answer;
    }

    console.log('[apply-questions] writing text', chosen);
    await field.click();
    await field.fill(String(chosen));
  }

  return { ok: true };
}

async function fillCurrentStep(page, profile) {
  const resumeHeadingPresent = await isResumeCoverStep(page);
  console.log('[apply-questions] fillCurrentStep', { resumeHeadingPresent });

  const radioResult = await fillRadioGroups(page, profile);
  if (!radioResult.ok) return radioResult;

  const checkboxResult = await fillCheckboxGroups(page, profile);
  if (!checkboxResult.ok) return checkboxResult;

  if (resumeHeadingPresent) {
    console.log('[apply-questions] skipping text/cover fields on resume step');
    return { ok: true };
  }

  const textResult = await fillTextFields(page, profile);
  if (!textResult.ok) return textResult;

  return { ok: true };
}

async function isVisibleEnabled(locator) {
  if (await locator.count() === 0) return false;
  const button = locator.first();
  if (!await button.isVisible().catch(() => false)) return false;
  return button.isEnabled();
}

module.exports = {
  answerWithLlm,
  fillCurrentStep,
  isVisibleEnabled,
  loadApplyProfile,
  ruleAnswer,
};
