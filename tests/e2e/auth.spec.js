// @ts-check
// Auth flow tests — register validation, login, /api/auth/me, logout, Google button render.
const { test, expect, request } = require('@playwright/test');

const uid = () => Math.random().toString(36).slice(2, 10);

test('register form validates required fields', async ({ page }) => {
  await page.goto('/register');
  await expect(page.locator('#register-form')).toBeVisible();
  // Step 1 should be active with empty inputs invalid
  await page.click('#next-btn');
  const emailInvalid = await page.$eval('input[name="email"]', el => /** @type {HTMLInputElement} */(el).validity.valueMissing);
  expect(emailInvalid).toBe(true);
});

test('register rejects mismatched passwords (step 1 -> step 2 nav)', async ({ page }) => {
  const email = `pw-${uid()}@test.example`;
  await page.goto('/register');
  await page.fill('input[name="name"]',     'Test User');
  await page.fill('input[name="email"]',    email);
  await page.fill('input[name="phone"]',    '+919876543210');
  await page.fill('input[name="password"]', 'StrongPassw0rd!');
  await page.fill('input[name="confirm"]',  'DifferentPw0rd!');
  await page.click('#next-btn'); // attempts to advance — password mismatch should block + show error
  await expect(page.locator('#auth-error')).toBeVisible();
  await expect(page.locator('#auth-error')).toContainText(/match/i);
});

test('login rejects bogus credentials', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[name="email"]',    `nobody-${uid()}@test.example`);
  await page.fill('input[name="password"]', 'wrong-password-123');
  await page.click('#login-btn');
  await expect(page.locator('#auth-error')).toBeVisible();
});

test('Google Sign-In button renders + config endpoint serves client id', async ({ page, baseURL }) => {
  // Hit config endpoint directly
  const api = await request.newContext({ baseURL });
  const res = await api.get('/api/auth/google-config.js');
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toMatch(/__GOOGLE_OAUTH_CLIENT_ID__\s*=/);
  await api.dispose();

  // Visit login page — Google iframe button mounts inside #g-signin-btn
  await page.goto('/login');
  await page.waitForFunction(() => {
    const el = document.querySelector('#g-signin-btn');
    return el && el.children.length > 0;
  }, { timeout: 10_000 });
});

test('/api/auth/me returns 401 when not logged in', async ({ baseURL }) => {
  const api = await request.newContext({ baseURL });
  const res = await api.get('/api/auth/me');
  expect(res.status()).toBe(401);
  await api.dispose();
});
