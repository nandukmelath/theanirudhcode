// @ts-check
// Smoke tests — every public page must load without 5xx or JS errors.
const { test, expect } = require('@playwright/test');

const PUBLIC_PAGES = [
  { path: '/',                 title: /theanirudhcode/i },
  { path: '/login',            title: /sign in|login/i },
  { path: '/register',         title: /register|sign up|create|begin/i },
  { path: '/forgot-password',  title: /forgot|password/i },
  { path: '/verify-email',     title: /verif/i },
];

for (const page of PUBLIC_PAGES) {
  test(`loads ${page.path}`, async ({ page: p }) => {
    test.setTimeout(60_000); // home has WebGL orb that slows tear-down
    const errors = [];
    p.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    p.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

    const res = await p.goto(page.path, { waitUntil: 'commit' });
    expect(res?.status(), `HTTP status on ${page.path}`).toBeLessThan(400);
    await expect(p).toHaveTitle(page.title);

    // Filter benign errors: 3rd-party scripts + expected 401 from /api/auth/me + WebGL driver noise
    const real = errors.filter(e =>
      !/gsi\/client|googleapis|accounts\.google|favicon|net::ERR_BLOCKED_BY_CLIENT|401\s*\(\)|status of 401|WebGL|GL Driver|GPU|gpu\.|GL_CLOSE_PATH/i.test(e)
    );
    expect(real, `JS errors on ${page.path}`).toEqual([]);
    // Stop running JS before teardown to free WebGL
    await p.evaluate(() => { try { window.stop(); } catch {} });
  });
}

test('static asset / 404 returns custom page', async ({ page }) => {
  const res = await page.goto('/this-route-does-not-exist-xyz');
  expect(res?.status()).toBe(404);
  await expect(page.locator('body')).toContainText(/404|not found/i);
});
