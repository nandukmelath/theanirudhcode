const Auth = {
  user: null,
  _ddListener: null,

  async init() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (r.ok) this.user = (await r.json()).user;
    } catch {}
    this._render();
    document.dispatchEvent(new CustomEvent('auth:ready'));
  },

  isLoggedIn() { return !!this.user; },
  isAdmin()    { return this.user?.role === 'admin'; },
  updateNavUI(){ this._render(); },

  _render() {
    this._renderDesktopNav();
    this._renderMobileMenu();
  },

  _renderDesktopNav() {
    const navAuth = document.querySelector('.nav-auth');
    if (!navAuth) return;

    if (this._ddListener) {
      document.removeEventListener('click', this._ddListener);
      this._ddListener = null;
    }

    if (this.isLoggedIn()) {
      const first = this.user.name.split(' ')[0];
      navAuth.innerHTML =
        '<div class="nav-user" id="_nuw">' +
          '<button type="button" class="ncta nav-user-btn" id="_ntb">' +
            first + ' <span style="font-size:.75em;opacity:.7">&#9660;</span>' +
          '</button>' +
          '<div class="nav-dropdown" id="_ndd">' +
            '<a href="/my-appointments" id="_nap">My Appointments</a>' +
            (this.isAdmin() ? '<a href="/portal-management" id="_nad">Admin Dashboard</a>' : '') +
            '<button type="button" id="_nlo">Sign Out</button>' +
          '</div>' +
        '</div>';

      const wrap = document.getElementById('_nuw');

      document.getElementById('_ntb').onclick = e => {
        e.stopPropagation();
        wrap.classList.toggle('open');
      };

      document.getElementById('_nlo').onclick = e => {
        e.stopPropagation();
        this.logout();
      };

      this._ddListener = e => {
        if (!wrap.contains(e.target)) wrap.classList.remove('open');
      };
      document.addEventListener('click', this._ddListener);
    } else {
      navAuth.innerHTML = '<a href="/login" class="ncta">Login</a>';
    }
  },

  _renderMobileMenu() {
    const mm = document.getElementById('mm');
    if (!mm) return;
    mm.querySelector('.mm-auth')?.remove();

    const el = document.createElement('div');
    el.className = 'mm-auth';
    el.style.cssText = 'margin-top:8px;display:flex;flex-direction:column;align-items:center;gap:10px;width:100%';

    if (this.isLoggedIn()) {
      el.innerHTML =
        '<a href="/my-appointments" class="mml">My Appointments</a>' +
        (this.isAdmin() ? '<a href="/portal-management" class="mml">Admin</a>' : '') +
        '<button type="button" class="btn-o mm-lo" style="margin-top:8px;min-width:200px"><span>Sign Out</span></button>';
      el.querySelector('.mm-lo').onclick = () => this.logout();
    } else {
      el.innerHTML =
        '<a href="/login"    class="mml" style="color:var(--gold2)">Login</a>' +
        '<a href="/register" class="mml">Register</a>';
    }
    mm.appendChild(el);
  },

  async login(email, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (res.ok) { this.user = data.user; this._render(); }
    return { ok: res.ok, data };
  },

  async register(name, email, password, phone) {
    const res = await fetch('/api/auth/register', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, phone })
    });
    const data = await res.json();
    if (res.ok) { this.user = data.user; this._render(); }
    return { ok: res.ok, data };
  },

  async logout() {
    // NB: Content-Type must be application/json to pass the server-side CSRF guard,
    // otherwise the server returns 415 and the cookie is never cleared.
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
    } catch {}
    this.user = null;
    this._render();
    location.href = '/';
  }
};

document.addEventListener('DOMContentLoaded', () => Auth.init());
