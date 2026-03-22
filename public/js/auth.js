/* ═══════════════════════════════════════
   AUTH STATE MANAGER
   Manages login state across all pages
═══════════════════════════════════════ */

const Auth = {
  user: null,
  initialized: false,

  async init() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        Auth.user = data.user;
      }
    } catch {}
    Auth.initialized = true;
    Auth.updateNavUI();
    document.dispatchEvent(new CustomEvent('auth:ready'));
  },

  isLoggedIn() { return !!Auth.user; },
  isAdmin() { return Auth.user && Auth.user.role === 'admin'; },

  updateNavUI() {
    // Desktop nav
    const navAuth = document.querySelector('.nav-auth');
    if (navAuth) {
      if (Auth.isLoggedIn()) {
        const firstName = Auth.user.name.split(' ')[0];
        navAuth.innerHTML = `
          <div class="nav-user">
            <button class="ncta nav-user-btn">${firstName}</button>
            <div class="nav-dropdown">
              <a href="/my-appointments">My Appointments</a>
              ${Auth.isAdmin() ? '<a href="/admin">Admin Dashboard</a>' : ''}
              <button id="nav-logout">Logout</button>
            </div>
          </div>`;
        const logoutBtn = document.getElementById('nav-logout');
        if (logoutBtn) logoutBtn.addEventListener('click', () => Auth.logout());
      } else {
        navAuth.innerHTML = `
          <a href="/login" class="ncta">Login</a>`;
      }
    }

    // Mobile menu
    const mmenu = document.getElementById('mm');
    if (mmenu) {
      let authLink = mmenu.querySelector('.mm-auth');
      if (authLink) authLink.remove();

      const el = document.createElement('div');
      el.className = 'mm-auth';
      el.style.marginTop = '8px';

      if (Auth.isLoggedIn()) {
        el.innerHTML = `
          <a href="/my-appointments" class="mml" style="font-size:clamp(20px,4vw,32px)">My Appointments</a>
          <button class="btn-o mm-logout" style="margin-top:12px"><span>Logout</span></button>`;
        el.querySelector('.mm-logout').addEventListener('click', () => Auth.logout());
      } else {
        el.innerHTML = `
          <a href="/login" class="mml" style="font-size:clamp(20px,4vw,32px);color:var(--gold2)">Login</a>
          <a href="/register" class="mml" style="font-size:clamp(20px,4vw,32px)">Register</a>`;
      }
      mmenu.appendChild(el);
    }
  },

  async login(email, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (res.ok) {
      Auth.user = data.user;
      Auth.updateNavUI();
    }
    return { ok: res.ok, data };
  },

  async register(name, email, password, phone) {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, phone })
    });
    const data = await res.json();
    if (res.ok) {
      Auth.user = data.user;
      Auth.updateNavUI();
    }
    return { ok: res.ok, data };
  },

  async logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    Auth.user = null;
    Auth.updateNavUI();
    if (window.location.pathname === '/my-appointments') {
      window.location.href = '/';
    }
  }
};

document.addEventListener('DOMContentLoaded', () => Auth.init());
