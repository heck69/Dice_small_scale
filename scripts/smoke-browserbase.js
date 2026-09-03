require('dotenv').config();

const { openBrowser, closeBrowser, useBrowserbase } = require('../lib/browser');

async function main() {
  if (!useBrowserbase) {
    throw new Error('Set USE_BROWSERBASE=true to run this smoke test.');
  }
  if (!process.env.BROWSERBASE_API_KEY) {
    throw new Error('BROWSERBASE_API_KEY is missing.');
  }
  if (!process.env.BROWSERBASE_PROJECT_ID) {
    throw new Error('BROWSERBASE_PROJECT_ID is missing. Copy it from Browserbase Settings.');
  }

  console.log('Opening Browserbase session...');
  const handle = await openBrowser({ headless: true });
  try {
    console.log(`sessionId=${handle.sessionId}`);
    console.log(`provider=${handle.provider}`);
    await handle.page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const title = await handle.page.title();
    console.log(`page title: ${title}`);
    console.log(`replay: https://www.browserbase.com/sessions/${handle.sessionId}`);
    console.log('Smoke test OK');
  } finally {
    await closeBrowser(handle);
  }
}

main().catch((error) => {
  console.error('Smoke test failed:', error.message);
  process.exit(1);
});
