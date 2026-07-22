// Granted AI automation via Playwright.
//
// Exposes: login(), discover(), draft(), submit()  — all take a fresh browser
// context so credentials never persist to disk. The caller (server.mjs) passes
// credentials that came from the dashboard vault at execution time.
//
// SECURITY: never log credentials; never return them. submit() refuses without
// an operator approval token.

import { chromium } from 'playwright';

const BASE = 'https://grantedai.com';

// Centralized selectors — update HERE if Granted's DOM changes (see README).
const SELECTORS = {
  emailInput: 'input[type="email"], input[placeholder="you@example.org"]',
  passwordInput: 'input[type="password"], input[placeholder="Password"]',
  signInButton: 'button:has-text("Sign in")',
  // Search page (from the landing hero + app search)
  searchInput: 'input[placeholder*="community garden"], input[type="search"], input[placeholder*="research"]',
  findGrantsButton: 'button:has-text("Find Grants")',
  resultRow: '[data-testid="grant-result"], article, li:has(a[href*="/grant"])',
  resultTitle: 'h2, h3, [data-testid="grant-title"]',
  resultFunder: '[data-testid="funder"], .funder',
  resultAmount: '[data-testid="amount"], .amount',
  resultDeadline: '[data-testid="deadline"], time',
  // Draft flow
  draftButton: 'button:has-text("Draft"), button:has-text("Write")',
  draftTextarea: 'textarea, [contenteditable="true"]',
  // Submit (guarded)
  submitButton: 'button:has-text("Submit")'
};

const NAV_TIMEOUT = 45_000;

async function withContext(fn, { headless = true } = {}) {
  const browser = await chromium.launch({ headless });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);
    return await fn(page, ctx);
  } finally {
    await browser.close(); // context (and any session cookies) destroyed here
  }
}

/** Log in with vault-provided credentials. Returns the storage state (cookies)
 * so a single session can be reused across discover/draft within one call. */
async function doLogin(page, { email, password }) {
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.fill(SELECTORS.emailInput, email);
  await page.fill(SELECTORS.passwordInput, password);
  await page.click(SELECTORS.signInButton);
  // Wait for navigation away from the login page (dashboard/app).
  await page.waitForURL((u) => !/\/auth\/login/.test(u.toString()), { timeout: NAV_TIMEOUT }).catch(() => {});
  const loggedIn = !/\/auth\/login/.test(page.url());
  if (!loggedIn) {
    // Check for a visible error without leaking the password.
    const err = await page.locator('[role="alert"], .error').first().textContent().catch(() => null);
    throw new Error(`login failed${err ? `: ${err.trim().slice(0, 120)}` : ' (still on login page)'}`);
  }
}

/** Tier-1: search for matching grants, return scrubbed structured rows. */
export async function discover({ email, password, keywords, maxResults = 20 }) {
  return withContext(async (page) => {
    await doLogin(page, { email, password });
    // Go to search; Granted's hero search accepts free text.
    await page.goto(`${BASE}/grants`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const input = page.locator(SELECTORS.searchInput).first();
    if (await input.count()) {
      await input.fill(keywords);
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(3000); // let results render
    const rows = await page.locator(SELECTORS.resultRow).all();
    const results = [];
    for (const row of rows.slice(0, maxResults)) {
      const text = (s) => row.locator(s).first().textContent().then((t) => (t || '').trim()).catch(() => '');
      const link = await row.locator('a[href*="/grant"]').first().getAttribute('href').catch(() => null);
      results.push({
        title: await text(SELECTORS.resultTitle),
        funder: await text(SELECTORS.resultFunder),
        amount: await text(SELECTORS.resultAmount),
        deadline: await text(SELECTORS.resultDeadline),
        url: link ? (link.startsWith('http') ? link : BASE + link) : null
      });
    }
    return { ok: true, count: results.length, keywords, results };
  });
}

/** Tier-1: open a grant, run Granted's AI drafting, return the draft text. */
export async function draft({ email, password, grantUrl, projectSummary }) {
  return withContext(async (page) => {
    await doLogin(page, { email, password });
    if (!grantUrl) throw new Error('grantUrl required');
    await page.goto(grantUrl, { waitUntil: 'domcontentloaded' });
    const btn = page.locator(SELECTORS.draftButton).first();
    if (await btn.count()) await btn.click();
    // If Granted asks for context, provide the project summary.
    const ta = page.locator(SELECTORS.draftTextarea).first();
    if (projectSummary && (await ta.count())) {
      await ta.fill(projectSummary);
      await page.keyboard.press('Control+Enter').catch(() => {});
    }
    await page.waitForTimeout(8000); // AI drafting takes time
    const draftText = await page.locator(SELECTORS.draftTextarea).first().inputValue()
      .catch(async () => (await page.locator(SELECTORS.draftTextarea).first().textContent()) || '');
    return { ok: true, grantUrl, draftChars: (draftText || '').length, draftText: draftText || '' };
  });
}

/** Tier-2: SUBMIT. Refuses without an operator approval token. Never autonomous. */
export async function submit({ email, password, grantUrl, approvalToken, expectedApprovalToken }) {
  if (!approvalToken || approvalToken !== expectedApprovalToken) {
    throw new Error('refused: grant submission requires a valid operator approval token');
  }
  return withContext(async (page) => {
    await doLogin(page, { email, password });
    await page.goto(grantUrl, { waitUntil: 'domcontentloaded' });
    const btn = page.locator(SELECTORS.submitButton).first();
    if (!(await btn.count())) throw new Error('submit button not found — do not assume submitted');
    await btn.click();
    await page.waitForTimeout(4000);
    const confirm = await page.locator('text=/submitted|received|thank you/i').first().count();
    return { ok: confirm > 0, grantUrl, submitted: confirm > 0 };
  });
}
