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
        if (typeof Toast !== 'undefined') Toast.success('Account created! Welcome to your healing journey.');
        signupForm.reset();
        onAuthSuccess();
      } else {
        if (typeof Toast !== 'undefined') Toast.error(result.data.error || 'Registration failed');
      }
    } catch {
      if (typeof Toast !== 'undefined') Toast.error('Connection error. Please try again.');
    } finally {
      setLoading(btn, false);
    }
  });
})();
