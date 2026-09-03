require('dotenv').config();

const crypto = require('crypto');
const { Bot } = require('node-telegram-bot-api');
const sgMail = require('@sendgrid/mail');
const { createServiceClient } = require('./lib/supabase');
const { fillCurrentStep, isVisibleEnabled, loadApplyProfile } = require('./lib/dice-apply-questions');
const { openBrowser, closeBrowser, useBrowserbase, maxConcurrent } = require('./lib/browser');
const { createApplyQueue } = require('./lib/apply-queue');
const { startApplyWorkers } = require('./lib/apply-worker');
const { notifyIMessage } = require('./lib/loopmessage');

const imessageEnabled = Boolean(process.env.LOOPMESSAGE_API_KEY);

const botToken = process.env.BOT_TOKEN;
const allowedChatId = process.env.CHAT_ID ? Number(process.env.CHAT_ID) : null;
const dicePassword = process.env.DICE_PASSWORD;
const sendGridApiKey = process.env.SENDGRID_API_KEY;
const senderEmail = process.env.SENDER_EMAIL || 'noreply@applywizz.com'; // Placeholder

if (!botToken) {
  throw new Error('BOT_TOKEN must be set in the environment.');
}
if (!dicePassword) {
  throw new Error('DICE_PASSWORD must be set in the environment.');
}

const supabase = createServiceClient();
const applyQueue = createApplyQueue(supabase);
let applyWorkerController = null;

sgMail.setApiKey(sendGridApiKey);
const loginUrl = 'https://www.dice.com/dashboard/login';

if (!botToken) {
  throw new Error('BOT_TOKEN must be set in the environment.');
}

const bot = new Bot(botToken);
const userStates = new Map();

function stateFor(chatId) {
  if (!userStates.has(chatId)) {
    userStates.set(chatId, {
      conversation: null,
      workflowActive: false,
      jobRunnerActive: false,
      browser: null,
      decisionResolver: null,
      pendingJobUrl: {}, // Store URL by hash for button callbacks
      completionNotified: false,
      knownJobUrls: new Set(),
    });
  }
  return userStates.get(chatId);
}

// === TELEGRAM HELPERS ===
function sendMessage(chatId, text, options = {}) {
  if (!chatId || isNaN(Number(chatId))) return Promise.resolve();
  return bot.api.sendMessage({ chat_id: chatId, text, ...options }).catch(console.error);
}

function notifyIMessage(clientId, text) {
  if (!imessageEnabled || !clientId) return;
  getPhoneHandleForClient(supabase, clientId)
    .then((phone) => {
      if (phone) return sendIMessage(phone, text);
    })
    .catch((err) => console.error('[iMessage notification error]:', err.message));
}

function sendMessageWithButtons(chatId, text, buttons) {
  return sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: buttons
    }
  });
}

function waitForConversationReply(chatId) {
  const state = stateFor(chatId);
  return new Promise((resolve, reject) => {
    state.conversation = { resolve, reject };
  });
}

function waitForDecision(chatId) {
  const state = stateFor(chatId);
  return new Promise((resolve) => {
    state.decisionResolver = resolve;
  });
}

// === OTP HELPERS ===
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

function hashOtp(code) {
  return crypto.createHash('sha256').update(String(code).trim()).digest('hex');
}

async function saveOTP(chatId, email, otp) {
  const { error } = await supabase.from('otp_challenges').upsert({
    telegram_chat_id: chatId,
    email,
    code_hash: hashOtp(otp),
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Could not save OTP: ${error.message}`);
}

async function verifyOTP(chatId, enteredCode) {
  const { data, error } = await supabase
    .from('otp_challenges')
    .select('code_hash, expires_at')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();

  if (error) throw new Error(`Could not read OTP: ${error.message}`);
  if (!data) return { ok: false, reason: 'expired' };
  if (Date.parse(data.expires_at) <= Date.now()) {
    await deleteOTP(chatId);
    return { ok: false, reason: 'expired' };
  }
  if (data.code_hash !== hashOtp(enteredCode)) return { ok: false, reason: 'invalid' };
  return { ok: true };
}

async function deleteOTP(chatId) {
  const { error } = await supabase.from('otp_challenges').delete().eq('telegram_chat_id', chatId);
  if (error) console.error(`[User ${chatId}] Failed to delete OTP:`, error.message);
}

async function sendOTPEmail(email, otp) {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured. OTP not sent via email.');
    return false;
  }

  try {
    await sgMail.send({
      to: email,
      from: senderEmail,
      subject: 'Your OTP Verification Code',
      html: `<p>Your OTP code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`,
    });
    console.log(`[OTP] Sent to ${email}`);
    return true;
  } catch (error) {
    console.error(`[OTP] Failed to send to ${email}:`, error.message);
    return false;
  }
}

// === USER MATCHING HELPERS ===
async function findUserByEmail(companyEmail) {
  const { data, error } = await supabase
    .from('clients')
    .select('id, applywizz_id, company_email, full_name')
    .eq('company_email', companyEmail.trim())
    .maybeSingle();

  if (error) {
    console.error('Supabase client lookup failed:', error.message);
    return null;
  }

  return data;
}

async function linkTelegramChat(chatId, clientId) {
  const { error } = await supabase.from('telegram_links').upsert(
    {
      telegram_chat_id: chatId,
      client_id: clientId,
      linked_at: new Date().toISOString(),
    },
    { onConflict: 'telegram_chat_id' }
  );

  if (error) {
    throw new Error(`Failed to save telegram link: ${error.message}`);
  }
}

async function getClientIdForChat(chatId) {
  const { data, error } = await supabase
    .from('telegram_links')
    .select('client_id')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();

  if (error) {
    console.error(`[User ${chatId}] Failed to load telegram link:`, error.message);
    return null;
  }
  return data?.client_id || null;
}

function storageStateIsValid(storageState) {
  return Boolean(storageState) && Array.isArray(storageState.cookies) && Array.isArray(storageState.origins);
}

async function readActiveSession(chatId) {
  const { data, error } = await supabase
    .from('dice_sessions')
    .select('telegram_chat_id, client_id, email, applywizz_id, storage_state')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();

  if (error) {
    console.error(`[User ${chatId}] Failed to load Dice session:`, error.message);
    return null;
  }
  if (!data || !storageStateIsValid(data.storage_state)) return null;

  return {
    chatId,
    email: data.email,
    applywizz_id: data.applywizz_id,
    clientId: data.client_id,
    storageState: data.storage_state,
  };
}

async function saveSession(context, chatId, email, applywizz_id, clientId) {
  const storageState = await context.storageState();
  const resolvedClientId = clientId || await getClientIdForChat(chatId);
  if (!resolvedClientId) {
    throw new Error('Cannot save Dice session: Telegram chat is not linked to a client.');
  }

  const { error } = await supabase.from('dice_sessions').upsert({
    telegram_chat_id: chatId,
    client_id: resolvedClientId,
    email,
    applywizz_id: applywizz_id || null,
    storage_state: storageState,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Could not save Dice session: ${error.message}`);

  return {
    chatId,
    email,
    applywizz_id,
    clientId: resolvedClientId,
    storageState,
  };
}

async function getAllRegisteredUsers() {
  const { data, error } = await supabase.from('dice_sessions').select('telegram_chat_id');
  if (error) {
    console.error('Failed to list Dice sessions:', error.message);
    return [];
  }
  return (data || []).map((row) => Number(row.telegram_chat_id));
}

// === AUTOMATION HELPERS ===
function randomDelay(minSeconds, maxSeconds) {
  const minMs = minSeconds * 1000;
  const maxMs = maxSeconds * 1000;
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function waitRandom(minSeconds, maxSeconds, label = null) {
  const ms = randomDelay(minSeconds, maxSeconds);
  if (label) console.log(`${label}: waiting ${ms / 1000} seconds...`);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function typeWithHumanDelay(page, selector, value) {
  const field = page.locator(selector);
  await field.fill('');
  await field.pressSequentially(value, { delay: 90 + Math.random() * 140 });
}

// === LOGIN ===
async function runLogin(chatId, credentials, isBackgroundRefresh = false) {
  const state = stateFor(chatId);
  const handle = await openBrowser({ headless: isBackgroundRefresh || useBrowserbase });
  if (!isBackgroundRefresh) state.browser = handle.browser;
  const { context, page, sessionId } = handle;

  try {
    if (sessionId) {
      console.log(`[User ${chatId}] Login browser session: ${sessionId}`);
      if (!isBackgroundRefresh) {
        await sendMessage(chatId, 'Opening remote browser for login...\n');
          // Replay: https://www.browserbase.com/sessions/${sessionId}`);
      }
    }

    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[type="email"]', { timeout: 30000 });
    await typeWithHumanDelay(page, 'input[type="email"]', credentials.email);
    await waitRandom(2, 5);
    await page.click('[data-testid="sign-in-button"]');

    await page.waitForSelector('input[type="password"]', { timeout: 30000 });
    await typeWithHumanDelay(page, 'input[type="password"]', dicePassword);
    await waitRandom(2, 6);
    await page.click('[data-testid="submit-password"]');
    await waitRandom(5, 15);
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => { });
    await page.waitForTimeout(3000);

    if (page.url().includes('/login')) {
      throw new Error(`Login did not complete. Current URL: ${page.url()}`);
    }

    const savedSession = await saveSession(
      context,
      chatId,
      credentials.email,
      credentials.applywizz_id,
      credentials.clientId
    );
    console.log(`[User ${chatId}] Login completed successfully.`);
    return savedSession;
  } finally {
    await closeBrowser(handle);
    if (!isBackgroundRefresh) state.browser = null;
  }
}

async function refreshLogin(chatId) {
  console.log(`[User ${chatId}] Dice session is missing or expired. Running background auto-login...`);
  const activeSession = await readActiveSession(chatId);
  if (!activeSession || !activeSession.email) {
    throw new Error('No email found in active session to refresh.');
  }

  await runLogin(chatId, {
    email: activeSession.email,
    applywizz_id: activeSession.applywizz_id,
    clientId: activeSession.clientId,
  }, true);
  const refreshedSession = await readActiveSession(chatId);
  if (!refreshedSession) throw new Error('Background login completed without creating an active session.');

  return refreshedSession;
}

// === JOBS & APPLICATIONS ===
async function readJobUrls() {
  const { data, error } = await supabase
    .from('jobs')
    .select('url')
    .eq('active', true)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to load jobs:', error.message);
    return [];
  }
  return (data || []).map((row) => row.url);
}

async function saveAppliedJob(chatId, url, jobName, status) {
  const clientId = await getClientIdForChat(chatId);
  if (!clientId) {
    console.error(`[User ${chatId}] Cannot save application: no linked client.`);
    return;
  }

  const { data: job } = await supabase.from('jobs').select('id').eq('url', url).maybeSingle();
  const { error } = await supabase.from('applications').upsert(
    {
      client_id: clientId,
      telegram_chat_id: chatId,
      job_id: job?.id || null,
      url,
      job_name: jobName || 'Unknown Job',
      status,
      applied_at: new Date().toISOString(),
    },
    { onConflict: 'client_id,url' }
  );

  if (error) {
    console.error(`[User ${chatId}] Failed to save application:`, error.message);
    return;
  }
  console.log(`[User ${chatId}] Saved job decision: ${status} for ${url}`);
}

async function hasHandledJob(chatId, url) {
  const clientId = await getClientIdForChat(chatId);
  if (!clientId) return false;

  const { data, error } = await supabase
    .from('applications')
    .select('id')
    .eq('client_id', clientId)
    .eq('url', url)
    .maybeSingle();

  if (error) {
    console.error(`[User ${chatId}] Failed to check applications:`, error.message);
    return false;
  }
  if (data) {
    await applyQueue.clearStaleClientJobs(clientId).catch(() => {});
    return true;
  }

  const handled = await applyQueue.hasActiveOrFinishedQueueItem(clientId, url);
  if (handled) {
    await applyQueue.clearStaleClientJobs(clientId).catch(() => {});
  }
  return handled;
}

// === JOB APPLICATION FLOW ===
function sessionExpiredError() {
  const error = new Error('Dice session expired.');
  error.code = 'SESSION_EXPIRED';
  return error;
}

async function getJobName(page) {
  const jobTitle = (await page.locator('h1').first().textContent() || '').trim();
  const company = (await page.locator('[data-wa-click="djv-job-company-profile-click"]').first().textContent() || '').trim();
  return company ? `${jobTitle} (${company})` : jobTitle;
}

async function applyToJobOnPage(page, jobName, url, chatId, clientId = null) {
  await waitRandom(5, 15, 'After opening URL');

  const applyButton = page.getByTestId('apply-button');
  const applyCount = await applyButton.count();
  if (applyCount === 0) {
    console.log(`Apply button not found; skipping URL: ${url}`);
    return false;
  }

  await applyButton.waitFor({ state: 'visible', timeout: 30000 });
  await applyButton.scrollIntoViewIfNeeded();

  const popupPromise = page.context()
    .waitForEvent('page', { timeout: 5000 })
    .catch(() => null);
  await applyButton.click();
  const applicationPage = await Promise.race([
    popupPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
  ]) || page;

  await applicationPage.waitForLoadState('domcontentloaded').catch(() => { });
  await applicationPage.waitForLoadState('networkidle').catch(() => { });
  await waitRandom(5, 15, 'After Apply opens application page');
  if (applicationPage.url().includes('/login')) throw sessionExpiredError();

  if (!applicationPage.url().includes('dice.com')) {
    await saveAppliedJob(chatId, url, jobName, 'external');
    sendMessage(chatId, `⚠️ Skipped ${jobName}: Redirected to external site.`);
    notifyIMessage(clientId, `⚠️ Skipped ${jobName}: Redirected to external site.`);
    return false;
  }

  const resolvedClientId = clientId || await getClientIdForChat(chatId);
  const applyProfile = await loadApplyProfile(supabase, resolvedClientId);
  console.log('[apply-questions] loaded profile', {
    clientId: resolvedClientId || null,
    hasOffice: applyProfile.can_work_3_days_in_office ?? null,
  });

  while (true) {
    if (applicationPage.url().includes('/login')) throw sessionExpiredError();

    const nextButton = applicationPage.getByRole('button', { name: /^Next$/i });
    const submitButton = applicationPage.getByRole('button', { name: /^Submit$/i });

    try {
      await Promise.any([
        nextButton.waitFor({ state: 'visible', timeout: 10000 }),
        submitButton.waitFor({ state: 'visible', timeout: 10000 })
      ]);
    } catch (e) {
      await saveAppliedJob(chatId, url, jobName, 'external_or_failed');
      sendMessage(chatId, `⚠️ Skipped ${jobName}: Missing Next/Submit (likely an extra question we could not fill).`);
      notifyIMessage(clientId, `⚠️ Skipped ${jobName}: Missing Next/Submit (additional question required).`);
      return false;
    }

    const nextVisible = await nextButton.count() > 0 && await nextButton.first().isVisible().catch(() => false);
    const submitVisible = await submitButton.count() > 0 && await submitButton.first().isVisible().catch(() => false);

    if (submitVisible && !nextVisible) {
      break;
    }

    if (nextVisible) {
      const filled = await fillCurrentStep(applicationPage, applyProfile);
      if (!filled.ok) {
        await saveAppliedJob(chatId, url, jobName, 'external_or_failed');
        sendMessage(chatId, `⚠️ Skipped ${jobName}: ${filled.reason || 'Could not answer an application question.'}`);
        notifyIMessage(clientId, `⚠️ Skipped ${jobName}: ${filled.reason || 'Could not answer an application question.'}`);
        return false;
      }

      if (!await isVisibleEnabled(nextButton)) {
        await saveAppliedJob(chatId, url, jobName, 'external_or_failed');
        sendMessage(chatId, `⚠️ Skipped ${jobName}: Next stayed disabled after filling questions.`);
        notifyIMessage(clientId, `⚠️ Skipped ${jobName}: Next stayed disabled after filling questions.`);
        return false;
      }

      await nextButton.first().scrollIntoViewIfNeeded();
      await nextButton.first().click();
      await applicationPage.waitForLoadState('networkidle').catch(() => { });
      await waitRandom(10, 20, 'After Next opens new page');
      continue;
    }

    break;
  }

  if (applicationPage.url().includes('/login')) throw sessionExpiredError();

  const submitButton = applicationPage.getByRole('button', { name: /^Submit$/i });
  if (await isVisibleEnabled(submitButton)) {
    await submitButton.first().scrollIntoViewIfNeeded();
    await submitButton.first().click();
    await applicationPage.waitForLoadState('networkidle').catch(() => { });
    await waitRandom(1,4, 'After Submit opens next page');

    await saveAppliedJob(chatId, url, jobName, 'completed');
    sendMessage(chatId, `✅ Application submitted successfully for:\n${jobName}`);
    notifyIMessage(clientId, `✅ Application submitted successfully for:\n${jobName}`);
    return true;
  }

  await saveAppliedJob(chatId, url, jobName, 'failed');
  sendMessage(chatId, `⚠️ Skipped ${jobName}: Could not complete application.`);
  notifyIMessage(clientId, `⚠️ Skipped ${jobName}: Could not complete application.`);
  return false;
}

// Runs one queued apply on Browserbase/local. Throws on hard failure.
async function executeQueuedApply(job) {
  const chatId = job.telegram_chat_id ? Number(job.telegram_chat_id) : null;
  const clientId = job.client_id;
  const url = job.url;

  if (chatId) {
    await sendMessage(chatId, `Starting application from queue:\n${url}`);
  }

  let activeSession = chatId ? await readActiveSession(chatId) : null;
  if (!activeSession) {
    if (chatId) {
      activeSession = await refreshLogin(chatId);
    }
  }

  let handle = await openBrowser({
    storageState: activeSession?.storageState,
    headless: useBrowserbase,
  });
  if (handle.sessionId) {
    console.log(`[User ${chatId || clientId}] Apply browser session: ${handle.sessionId}`);
  }

  try {
    let retryAfterLogin = true;
    while (retryAfterLogin) {
      retryAfterLogin = false;
      const page = await handle.context.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);

        if (page.url().includes('/login')) {
          if (chatId) {
            activeSession = await refreshLogin(chatId);
          }
          await closeBrowser(handle);
          handle = await openBrowser({
            storageState: activeSession?.storageState,
            headless: useBrowserbase,
          });
          retryAfterLogin = true;
          continue;
        }

        const jobName = await getJobName(page);
        await applyToJobOnPage(page, jobName, url, chatId, clientId);
      } catch (error) {
        if (error.code === 'SESSION_EXPIRED') {
          if (chatId) {
            activeSession = await refreshLogin(chatId);
          }
          await closeBrowser(handle);
          handle = await openBrowser({
            storageState: activeSession?.storageState,
            headless: useBrowserbase,
          });
          retryAfterLogin = true;
        } else {
          await saveAppliedJob(chatId, url, 'Failed', 'failed');
          if (chatId) {
            sendMessage(chatId, `Failed to apply: ${error.message}`);
          }
          notifyIMessage(clientId, `⚠️ Failed to apply to ${url}: ${error.message}`);
          throw error;
        }
      } finally {
        if (page && !page.isClosed()) await page.close().catch(() => {});
      }
    }
  } finally {
    await closeBrowser(handle);
  }
}

// Background loop for an individual user: prompt Yes/No, enqueue on Yes.
async function runJobsLoop(chatId) {
  const state = stateFor(chatId);
  state.jobRunnerActive = true;
  console.log(`[User ${chatId}] Job loop started.`);

  while (state.jobRunnerActive) {
    const urls = await readJobUrls();
    const hasNewUrl = urls.some((url) => !state.knownJobUrls.has(url));
    state.knownJobUrls = new Set(urls);

    if (state.completionNotified && !hasNewUrl) {
      await new Promise((r) => setTimeout(r, 10000));
      continue;
    }

    if (hasNewUrl) {
      state.completionNotified = false;
      console.log(`[User ${chatId}] New job URL detected; resuming scanner.`);
    }

    let offeredAny = false;
    let unhandledUrlFound = false;

    for (const url of urls) {
      if (!state.jobRunnerActive) {
        console.log(`[User ${chatId}] Job runner stopped.`);
        break;
      }

      if (await hasHandledJob(chatId, url)) {
        console.log(`[User ${chatId}] Skipping already-handled job: ${url}`);
        continue;
      }

      unhandledUrlFound = true;

      if (state.workflowActive) {
        console.log(`[User ${chatId}] Workflow active, waiting 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      const clientId = await getClientIdForChat(chatId);
      if (!clientId) {
        await sendMessage(chatId, 'Cannot queue apply: Telegram is not linked to a client.');
        continue;
      }

      if (await applyQueue.hasActiveClientJob(clientId)) {
        console.log(`[User ${chatId}] Skipping additional prompt: client already has an active queued/running apply.`);
        continue;
      }

      console.log(`[User ${chatId}] Prompting for job: ${url}`);
      offeredAny = true;
      const jobHash = crypto.createHash('md5').update(url).digest('hex').substring(0, 16);
      state.pendingJobUrl[jobHash] = url;

      await sendMessageWithButtons(chatId, `New Job Found:\n${url}\n\nDo you want to apply?`, [
        [{ text: '✅ Yes', callback_data: `job_yes_${jobHash}` }],
        [{ text: '❌ No', callback_data: `job_no_${jobHash}` }],
      ]);

      const proceed = await waitForDecision(chatId);

      if (!proceed) {
        await saveAppliedJob(chatId, url, 'Skipped by user', 'rejected');
        await sendMessage(chatId, 'Job rejected. Moving to next.');
        continue;
      }

      const { data: jobRow } = await supabase.from('jobs').select('id').eq('url', url).maybeSingle();

      try {
        const { row, created, alreadyDone, activeClientJob } = await applyQueue.enqueueApplyJob({
          clientId,
          telegramChatId: chatId,
          url,
          jobId: jobRow?.id || null,
        });

        if (activeClientJob) {
          await sendMessage(chatId, 'An application for this client is already running. I’ll offer the next job once it finishes.');
          continue;
        }

        if (alreadyDone) {
          await sendMessage(chatId, 'This job was already completed earlier. Skipping.');
          continue;
        }

        const position = created ? await applyQueue.getQueuePosition(row.id) : null;
        const queuedCount = await applyQueue.countQueuedAhead();
        if (created && position) {
          await sendMessage(
            chatId,
            `Queued for apply (position ~${position}, ~${queuedCount || position} waiting).\nWorkers will pick this up when a browser slot is free.`
          );
        } else {
          await sendMessage(chatId, 'Already in the apply queue. Waiting for a worker...');
        }
      } catch (error) {
        console.error(`[User ${chatId}] Enqueue failed:`, error.message);
        await sendMessage(chatId, `Could not queue apply: ${error.message}`);
      }
    }

    const clientId = await getClientIdForChat(chatId);
    const activeClientJob = clientId && await applyQueue.hasActiveClientJob(clientId);
    if (
      urls.length > 0 &&
      !unhandledUrlFound &&
      !activeClientJob &&
      !state.completionNotified &&
      state.jobRunnerActive
    ) {
      state.completionNotified = true;
      await sendMessage(
        chatId,
        'All jobs from the CSV have been completed. I will wait for new job links.'
      );
    }

    if (!offeredAny && state.jobRunnerActive) {
      await new Promise((r) => setTimeout(r, 10000));
    }
  }

  console.log(`[User ${chatId}] Job runner stopped.`);
}

// === TELEGRAM COMMAND HANDLER ===
async function runSignInWorkflow(chatId, { greet = false } = {}) {
  const state = stateFor(chatId);
  if (state.workflowActive) {
    await sendMessage(chatId, 'An operation is already running. Complete it or use /cancel first.');
    return;
  }

  state.workflowActive = true;
  try {
    if (greet) {
      await sendMessage(chatId, 'Welcome');
    }

    let email;
    while (true) {
      await sendMessage(chatId, 'Enter email id');
      email = await waitForConversationReply(chatId);
      if (email === '/cancel') throw new Error('Cancelled by user.');

      const otp = generateOTP();
      await saveOTP(chatId, email, otp);
      await sendOTPEmail(email, otp);
      await sendMessage(chatId, 'An OTP has been sent to your email. Please enter it below (expires in 5 minutes).');

      let otpVerified = false;
      while (true) {
        const enteredOTP = await waitForConversationReply(chatId);
        if (enteredOTP === '/cancel') throw new Error('Cancelled by user.');

        const otpResult = await verifyOTP(chatId, enteredOTP);
        if (otpResult.ok) {
          otpVerified = true;
          break;
        }

        if (otpResult.reason === 'expired') {
          await sendMessage(chatId, 'OTP expired. Please enter your email again.');
          break;
        }

        await sendMessage(chatId, 'Invalid OTP. Please enter the OTP again.');
      }

      if (otpVerified) break;
    }

    await deleteOTP(chatId);
    await sendMessage(chatId, '✅ Email verified!');

    const user = await findUserByEmail(email);
    if (!user) {
      throw new Error('Email not found in our database. Please check and try again.');
    }

    await linkTelegramChat(chatId, user.id);
    await sendMessage(
      chatId,
      useBrowserbase
        ? 'Starting login in a remote Browserbase browser...'
        : 'Starting login in a visible browser...'
    );

    await runLogin(chatId, { email, applywizz_id: user.applywizz_id, clientId: user.id });
    await sendMessage(chatId, 'Login completed. I will now scan for jobs in the background.');

    state.workflowActive = false;
    if (!state.jobRunnerActive) {
      state.jobRunnerActive = true;
      runJobsLoop(chatId).catch(console.error);
    }
  } catch (e) {
    await sendMessage(chatId, `Operation failed: ${e.message}`);
    state.workflowActive = false;
  }
}

async function handleCommand(chatId, text) {
  const state = stateFor(chatId);
  const normalized = text.toLowerCase().replace(/[\/]+/g, '').trim();

  if (['continue', 'yes', 'y'].includes(normalized) && state.decisionResolver) {
    const resolver = state.decisionResolver;
    state.decisionResolver = null;
    resolver(true);
    return;
  }
  if (['stop', 'no', 'n'].includes(normalized) && state.decisionResolver) {
    const resolver = state.decisionResolver;
    state.decisionResolver = null;
    resolver(false);
    return;
  }

  if (normalized === 'cancel') {
    if (state.conversation) {
      const conversation = state.conversation;
      state.conversation = null;
      conversation.resolve('/cancel');
      await sendMessage(chatId, 'Cancelled.');
    }
    return;
  }

  if (state.conversation) {
    const conversation = state.conversation;
    state.conversation = null;
    conversation.resolve(text.trim());
    return;
  }

  if (state.workflowActive) {
    await sendMessage(chatId, 'An operation is already running. Complete it or use /cancel first.');
    return;
  }

  // First link /start: welcome + ask for email (no Sign In / Sign Up buttons)
  if (
    normalized === 'start' ||
    ['sign in', 'signin', 'login', 'log in'].includes(normalized)
  ) {
    await runSignInWorkflow(chatId, { greet: normalized === 'start' });
    return;
  }

  const linkedClientId = await getClientIdForChat(chatId);
  if (!linkedClientId) {
    await runSignInWorkflow(chatId, { greet: true });
    return;
  }

  await sendMessage(chatId, 'You are already linked. Send /start if you need to sign in again.');
}

bot.on('message', (ctx) => {
  const chatId = ctx.message?.chat.id;
  if (!chatId || (allowedChatId && chatId !== allowedChatId) || typeof ctx.message.text !== 'string') return;

  handleCommand(chatId, ctx.message.text).catch(async (error) => {
    stateFor(chatId).conversation = null;
    console.error(`Command failed: ${error.message}`);
    await sendMessage(chatId, `Operation failed: ${error.message}`);
  });
});

bot.on('callback_query', async (ctx) => {
  const chatId = ctx.from?.id;
  const data = ctx.callbackQuery?.data;
  const message = ctx.callbackQuery?.message;

  if (!chatId || !data) {
    console.warn('Received callback_query without chatId or data:', { chatId, data, ctx });
    return;
  }

  try {
    await ctx.answerCallbackQuery().catch(() => {});
    if (message) {
      await bot.api.editMessageReplyMarkup({
        chat_id: message.chat?.id || chatId,
        message_id: message.message_id,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }
  } catch (error) {
    console.warn('[callback] failed to clear button markup:', error.message);
  }

  // Handle job yes/no buttons
  if (data.startsWith('job_yes_')) {
    const resolver = stateFor(chatId).decisionResolver;
    if (resolver) {
      stateFor(chatId).decisionResolver = null;
      resolver(true);
    }
    return;
  }

  if (data.startsWith('job_no_')) {
    const resolver = stateFor(chatId).decisionResolver;
    if (resolver) {
      stateFor(chatId).decisionResolver = null;
      resolver(false);
    }
    return;
  }
});

// === BOOTSTRAP ===
(async () => {
  console.log('[Init] Testing bot token...');
  try {
    await bot.api.getMe();
    console.log('[Init] Bot token verified.');
  } catch (e) {
    console.error('[Init] Bot token test failed:', e.message);
    throw e;
  }

  console.log('[Init] Starting Telegram polling...');
  bot.startPolling();
  console.log('Main Telegram controller is running.');
  console.log(`[Init] Browser provider: ${useBrowserbase ? `browserbase (max ${maxConcurrent} concurrent)` : 'local'}`);

  applyWorkerController = startApplyWorkers({
    queue: applyQueue,
    executeJob: executeQueuedApply,
    concurrency: maxConcurrent,
    pollMs: 2000,
  });
  console.log(`[Init] Apply queue workers: ${maxConcurrent}`);

  const users = await getAllRegisteredUsers();
  console.log(`[Startup] Found ${users.length} registered user(s).`);
  for (const chatId of users) {
    const activeSession = await readActiveSession(chatId);
    if (activeSession) {
      console.log(`[Startup] Auto-starting background job scanner for user ${chatId}`);
      const state = stateFor(chatId);
      state.jobRunnerActive = true;
      runJobsLoop(chatId).catch(console.error);
    }
  }
})().catch((error) => {
  console.error(`Could not start controller: ${error.message}`);
  process.exit(1);
});

async function shutdown() {
  if (applyWorkerController) applyWorkerController.stop();
  for (const state of userStates.values()) {
    if (state.conversation) state.conversation.reject(new Error('Controller stopped.'));
    if (state.decisionResolver) state.decisionResolver(false);
    if (state.browser) await state.browser.close().catch(() => { });
    state.jobRunnerActive = false;
  }
  if (bot.isRunning()) await bot.stopPolling().catch(() => { });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);


// npm run import-clients -- /full/path/to/new-clients.json --if i store a json file and want to push to supabase
//CLIENTS_API_URL=https://your-crm.example/clients
//CLIENTS_API_TOKEN=optional-bearer-token
//npm run import-clients ---if i want to connect api and add json files directly.