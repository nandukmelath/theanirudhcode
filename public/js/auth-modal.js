/* ═══════════════════════════════════════
   AUTH MODAL — Inline Login/Signup
   Intercepts booking for unauthenticated users
═══════════════════════════════════════ */

(function() {
  const authModal = document.getElementById('auth-modal');
  const authClose = document.getElementById('auth-close');
  const loginForm = document.getElementById('auth-login-form');
  const signupForm = document.getElementById('auth-signup-form');
  const tabs = document.querySelectorAll('.auth-tab');

  if (!authModal) return;

  // Tab switching
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
      if (tab.dataset.tab === 'login') loginForm.classList.add('active');
      else signupForm.classList.add('active');
    });
  });

  // Open/Close
  function openAuthModal() {
    authModal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeAuthModal() {
    authModal.classList.remove('open');
    document.body.style.overflow = '';
  }

  authClose.addEventListener('click', closeAuthModal);
  authModal.addEventListener('click', (e) => { if (e.target === authModal) closeAuthModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && authModal.classList.contains('open')) closeAuthModal();
  });

  // Expose for booking modal
  window.openAuthModal = openAuthModal;
  window.closeAuthModal = closeAuthModal;

  function setLoading(btn, loading) {
    const span = btn.querySelector('span');
    if (loading) {
      btn.disabled = true;
      btn.dataset.orig = span.textContent;
      span.textContent = 'Please wait...';
      btn.style.opacity = '0.7';
    } else {
      btn.disabled = false;
      span.textContent = btn.dataset.orig || span.textContent;
      btn.style.opacity = '';
    }
  }

  function onAuthSuccess() {
    closeAuthModal();
    // Give a moment for Auth to update nav, then open booking
    setTimeout(() => {
      if (window.bookingModal) window.bookingModal.open();
    }, 300);
  }

  // LOGIN
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = loginForm.querySelector('.fsubmit');
    const email = loginForm.querySelector('[name="email"]').value.trim();
    const password = loginForm.querySelector('[name="password"]').value;

    if (!email || !password) {
      if (typeof Toast !== 'undefined') Toast.error('Please fill in all fields');
      return;
    }

    setLoading(btn, true);
    try {
      const result = await Auth.login(email, password);
      if (result.ok) {
        if (typeof Toast !== 'undefined') Toast.success('Welcome back!');
        loginForm.reset();
        onAuthSuccess();
      } else {
        if (typeof Toast !== 'undefined') Toast.error(result.data.error || 'Login failed');
      }
    } catch {
      if (typeof Toast !== 'undefined') Toast.error('Connection error. Please try again.');
    } finally {
      setLoading(btn, false);
    }
  });

  // SIGNUP
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = signupForm.querySelector('.fsubmit');
    const name = signupForm.querySelector('[name="name"]').value.trim();
    const email = signupForm.querySelector('[name="email"]').value.trim();
    const phone = signupForm.querySelector('[name="phone"]').value.trim();
    const password = signupForm.querySelector('[name="password"]').value;

    if (!name || !email || !password) {
      if (typeof Toast !== 'undefined') Toast.error('Please fill in all required fields');
      return;
    }
    if (password.length < 8) {
      if (typeof Toast !== 'undefined') Toast.error('Password must be at least 8 characters');
      return;
    }

    setLoading(btn, true);
    try {
      const result = await Auth.register(name, email, password, phone);
      if (result.ok) {
        signupForm.reset();
        // Server flow: signup creates account but requires email verification before login.
        // If `user` is missing in response, account is unverified — show check-email screen instead of opening booking.
        if (result.data && result.data.requiresVerification) {
          showCheckEmailScreen(email);
        } else {
          if (typeof Toast !== 'undefined') Toast.success('Account created! Welcome to your healing journey.');
          onAuthSuccess();
        }
      } else {
        if (typeof Toast !== 'undefined') Toast.error(result.data.error || 'Registration failed');
      }
    } catch {
      if (typeof Toast !== 'undefined') Toast.error('Connection error. Please try again.');
    } finally {
      setLoading(btn, false);
    }
  });

  function showCheckEmailScreen(email) {
    const body = authModal.querySelector('.auth-box') || authModal;
    const esc = (s) => { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; };
    const html = `
      <div style="text-align:center;padding:12px 6px">
        <div style="width:9px;height:9px;background:#d0af52;transform:rotate(45deg);margin:0 auto 22px"></div>
        <h2 style="font-family:'Cormorant',serif;font-size:clamp(24px,3.5vw,34px);font-weight:300;color:#f9f5ee;margin-bottom:10px">
          Check your <em style="color:#eedc88">inbox</em>
        </h2>
        <p style="color:rgba(249,245,238,.78);font-size:14px;line-height:1.85;font-weight:300;margin-bottom:24px">
          We sent a verification link to<br>
          <strong style="color:#eedc88">${esc(email)}</strong><br>
          Click the link to activate your account, then sign in.
        </p>
        <p style="color:rgba(249,245,238,.42);font-size:12px;line-height:1.65;margin-bottom:24px">
          Didn't receive it? Check your spam folder, or
          <a href="/verify-email" style="color:#eedc88;text-decoration:none">request a new link</a>.
        </p>
        <button type="button" id="_ck_close" style="display:inline-block;padding:12px 30px;background:#d0af52;color:#070707;font-family:'Tenor Sans',sans-serif;font-size:11px;letter-spacing:.22em;text-transform:uppercase;border:none;cursor:pointer">Got it</button>
      </div>`;
    body.innerHTML = html;
    const btn = document.getElementById('_ck_close');
    if (btn) btn.addEventListener('click', closeAuthModal);
  }
})();
