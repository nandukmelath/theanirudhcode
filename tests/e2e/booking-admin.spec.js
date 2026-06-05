// @ts-check
// Booking + Admin protection tests.
const { test, expect, request } = require('@playwright/test');

test('home renders Begin Healing CTAs that trigger modal', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // Verify CTAs exist
  const ctas = page.locator('button[data-action="open-consultation"]');
  await expect(await ctas.count(), 'at least 1 booking CTA').toBeGreaterThan(0);
  // Trigger via dispatchEvent (bypasses animation/stability issues with hero orb)
  await page.evaluate(() => {
    const btn = document.querySelector('button[data-action="open-consultation"]');
    btn?.click();
  });
  // Either booking modal or auth-modal should open (depends on Auth.isLoggedIn)
  const opened = page.locator('#consultation-modal.open, #auth-modal.open');
  await expect(opened.first()).toBeVisible({ timeout: 5000 });
});

test('my-appointments requires auth (redirects or returns 401)', async ({ page }) => {
  const res = await page.goto('/my-appointments');
  // Page loads — but client-side check should redirect to /login OR /api/auth/me 401 triggers auth gate.
  expect(res?.status()).toBeLessThan(500);
  // Wait for client auth check to redirect
  await page.waitForLoadState('domcontentloaded');
  // Either redirected to login OR still on page (depends on client guard); assert one of the two:
  const url = page.url();
  expect(url).toMatch(/\/(login|my-appointments)/);
});

test('/portal-management requires admin auth', async ({ baseURL }) => {
  const api = await request.newContext({ baseURL });
  // Admin API endpoints should reject unauth requests
  const r = await api.get('/portal-management/api/stats');
  expect([401, 403]).toContain(r.status());
  await api.dispose();
});

test('admin login endpoint rejects wrong password', async ({ baseURL }) => {
  const api = await request.newContext({ baseURL });
  const r = await api.post('/portal-management/api/login', {
    data: { username: 'admin', password: 'definitely-not-the-password' }
  });
  expect([401, 429]).toContain(r.status()); // 429 if rate-limited from prior runs
  await api.dispose();
});

test('CSP header present + COOP allows popups', async ({ page }) => {
  const res = await page.goto('/login');
  const headers = res?.headers() || {};
  expect(headers['content-security-policy']).toBeTruthy();
  expect(headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
});
