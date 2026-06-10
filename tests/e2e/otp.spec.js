// @ts-check
// OTP flow tests — request validation + verify error cases.
// Full success path needs email inbox access; here we cover validation + bad codes.
const { test, expect, request } = require('@playwright/test');

const uid = () => Math.random().toString(36).slice(2, 8);

test('/api/auth/otp/request rejects invalid email', async ({ baseURL }) => {
  const api = await request.newContext({ baseURL });
  const r = await api.post('/api/auth/otp/request', { data: { email: 'not-an-email' } });
  expect(r.status()).toBe(400);
  await api.dispose();
});

test('/api/auth/otp/request requires name for new account', async ({ baseURL }) => {
  const api = await request.newContext({ baseURL });
  const r = await api.post('/api/auth/otp/request', { data: { email: `new-${uid()}@otp.test` } });
  // New account — name missing
  expect(r.status()).toBe(400);
  const body = await r.json();
  expect(body.error).toMatch(/name/i);
  await api.dispose();
});

test('/api/auth/otp/verify rejects malformed code', async ({ baseURL }) => {
  const api = await request.newContext({ baseURL });
  const r = await api.post('/api/auth/otp/verify', { data: { email: `x-${uid()}@otp.test`, code: 'abc' } });
  expect(r.status()).toBe(400);
  await api.dispose();
});

test('/api/auth/otp/verify rejects wrong code (no active OTP)', async ({ baseURL }) => {
  const api = await request.newContext({ baseURL });
  const r = await api.post('/api/auth/otp/verify', { data: { email: `nobody-${uid()}@otp.test`, code: '000000' } });
  // No active OTP for that email — 401
  expect(r.status()).toBe(401);
  await api.dispose();
});

test('login page shows OTP toggle button', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('#otp-toggle')).toBeVisible();
});

test('register page shows OTP signup button', async ({ page }) => {
  await page.goto('/register');
  await expect(page.locator('#otp-toggle')).toBeVisible();
});

test('clicking OTP toggle reveals OTP form (login)', async ({ page }) => {
  await page.goto('/login');
  await page.click('#otp-toggle');
  await expect(page.locator('#otp-form')).toBeVisible();
  await expect(page.locator('#otp-email')).toBeVisible();
  await expect(page.locator('#login-form')).toBeHidden();
});

test('clicking OTP toggle reveals OTP signup form (register)', async ({ page }) => {
  await page.goto('/register');
  await page.click('#otp-toggle');
  await expect(page.locator('#otp-form')).toBeVisible();
  await expect(page.locator('#otp-name')).toBeVisible();
  await expect(page.locator('#otp-email')).toBeVisible();
});
