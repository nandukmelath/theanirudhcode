const API = '/portal-management/api';
let useJWT = false;

const loginScreen = document.getElementById('login-screen');
const dashboard   = document.getElementById('dashboard');
const loginBtn    = document.getElementById('login-btn');
const loginEmail  = document.getElementById('login-email');
const loginPass   = document.getElementById('login-pass');
const loginError  = document.getElementById('login-error');
const logoutBtn   = document.getElementById('logout-btn');

const params = new URLSearchParams(window.location.search);
if (params.get('calendar_success')) showAlert(params.get('calendar_success'), 'success');
if (params.get('calendar_error'))   showAlert(params.get('calendar_error'), 'error');
if (params.get('calendar_success') || params.get('calendar_error')) {
  history.replaceState({}, '', '/portal-management');
}

tryJWTLoad();

loginBtn.addEventListener('click', login);
loginPass.addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
logoutBtn.addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
  sessionStorage.removeItem('admin_token');
  window.location.href = '/';
});

// Event delegation — replaces all inline onclick/onchange in generated table HTML
document.addEventListener('click', e => {
  if (e.target.matches('[data-action="delete-sub"]'))    deleteSub(parseInt(e.target.dataset.id));
  if (e.target.matches('[data-action="cancel-appt"]'))   cancelAppt(parseInt(e.target.dataset.id));
  if (e.target.matches('[data-action="complete-appt"]')) completeAppt(parseInt(e.target.dataset.id));
});
document.addEventListener('change', e => {
  if (e.target.matches('[data-action="update-status"]')) updateStatus(parseInt(e.target.dataset.id), e.target.value);
});

async function tryJWTLoad() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      if (data.user.role === 'admin') { useJWT = true; showDashboard(); return; }
    }
  } catch {}
  const oldToken = sessionStorage.getItem('admin_token');
  if (oldToken) {
    try {
      const res = await fetch(`${API}/stats`, { headers: { 'x-admin-token': oldToken } });
      if (res.ok) { showDashboard(); return; }
    } catch {}
    sessionStorage.removeItem('admin_token');
  }
}

async function login() {
  const email = loginEmail.value;
  const password = loginPass.value;
  loginError.style.display = 'none';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.user.role === 'admin') { useJWT = true; showDashboard(); return; }
      loginError.textContent = 'This account does not have admin access';
      loginError.style.display = 'block';
      return;
    }
  } catch {}

  sessionStorage.setItem('admin_token', password);
  try {
    const res = await fetch(`${API}/stats`, { headers: { 'x-admin-token': password } });
    if (res.ok) { showDashboard(); return; }
  } catch {}
  sessionStorage.removeItem('admin_token');
  loginError.textContent = 'Invalid credentials';
  loginError.style.display = 'block';
}

function getHeaders() {
  if (useJWT) return { 'Content-Type': 'application/json' };
  const t = sessionStorage.getItem('admin_token') || '';
  return { 'Content-Type': 'application/json', 'x-admin-token': t };
}

async function showDashboard() {
  loginScreen.style.display = 'none';
  dashboard.style.display = 'block';
  await loadStats();
  loadSubscribers();
  loadConsultations();
  loadAppointments();
  loadSettings();
  checkCalendarStatus();
}

async function loadStats() {
  try {
    const res  = await fetch(`${API}/stats`, { headers: getHeaders() });
    const data = await res.json();
    document.getElementById('s-subs').textContent    = data.totalSubs;
    document.getElementById('s-consult').textContent = data.totalConsultations;
    document.getElementById('s-new').textContent     = data.newConsultations;
    document.getElementById('s-today').textContent   = data.todaySubs;
    document.getElementById('s-appt').textContent    = data.upcomingAppointments || 0;
    document.getElementById('s-patients').textContent = data.totalPatients || 0;
    document.getElementById('s-lives').textContent   = data.livesTransformed || 0;
    document.getElementById('s-active').textContent  = data.activeJourneys || 0;
  } catch {}
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-view').forEach(v => v.style.display = 'none');
    const view = document.getElementById('view-' + btn.dataset.view);
    if (view) view.style.display = '';
  });
});

async function loadSubscribers() {
  const res = await fetch(`${API}/subscribers`, { headers: getHeaders() });
  const { subscribers } = await res.json();
  const body = document.getElementById('subs-body');
  if (!subscribers.length) { body.innerHTML = '<tr><td colspan="5" class="empty">No subscribers yet</td></tr>'; return; }
  body.innerHTML = subscribers.map(s => `<tr>
    <td>${esc(s.name)}</td><td>${esc(s.email)}</td><td>${esc(s.source)}</td>
    <td>${new Date(s.subscribedAt || s.subscribed_at).toLocaleDateString()}</td>
    <td><button class="action-btn danger" data-action="delete-sub" data-id="${s.id}">Delete</button></td>
  </tr>`).join('');
}

async function loadConsultations() {
  const res = await fetch(`${API}/consultations`, { headers: getHeaders() });
  const { consultations } = await res.json();
  const body = document.getElementById('consult-body');
  if (!consultations.length) { body.innerHTML = '<tr><td colspan="7" class="empty">No consultations yet</td></tr>'; return; }
  body.innerHTML = consultations.map(c => `<tr>
    <td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${esc(c.phone || '—')}</td>
    <td>${esc(c.preferred_date || '—')}</td>
    <td style="max-width:200px">${esc(c.message || '—')}</td>
    <td><select class="status-select" data-action="update-status" data-id="${c.id}">
      ${['new','read','contacted','completed'].map(s => `<option value="${s}" ${c.status===s?'selected':''}>${s}</option>`).join('')}
    </select></td>
    <td>${new Date(c.created_at+'Z').toLocaleDateString()}</td>
  </tr>`).join('');
}

async function loadAppointments() {
  try {
    const res = await fetch('/api/appointments/all', { headers: getHeaders() });
    const { appointments } = await res.json();
    const body = document.getElementById('appt-body');
    if (!appointments || !appointments.length) { body.innerHTML = '<tr><td colspan="8" class="empty">No appointments yet</td></tr>'; return; }
    body.innerHTML = appointments.map(a => {
      const d = new Date(a.date + 'T00:00:00');
      const dateStr = d.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
      const startH = parseInt(a.time_start.split(':')[0]);
      const ampm = startH >= 12 ? 'PM' : 'AM';
      const dH   = startH > 12 ? startH - 12 : (startH || 12);
      const timeStr = dH + ':' + a.time_start.split(':')[1] + ' ' + ampm;
      return `<tr>
        <td>${esc(a.patient_name)}</td><td>${esc(a.patient_email)}</td>
        <td>${esc(a.patient_phone || '—')}</td><td>${dateStr}</td><td>${timeStr}</td>
        <td style="max-width:200px">${esc(a.health_concerns || '—')}</td>
        <td><span class="status-badge status-${a.status}">${a.status}</span></td>
        <td>${a.status === 'confirmed'
          ? `<button class="action-btn danger" data-action="cancel-appt" data-id="${a.id}">Cancel</button>
             <button class="action-btn" data-action="complete-appt" data-id="${a.id}">Complete</button>`
          : ''}</td>
      </tr>`;
    }).join('');
  } catch {}
}

async function deleteSub(id) {
  if (!confirm('Delete this subscriber?')) return;
  await fetch(`${API}/subscribers/${id}`, { method: 'DELETE', headers: getHeaders() });
  loadSubscribers(); loadStats();
}

async function updateStatus(id, status) {
  await fetch(`${API}/consultations/${id}`, {
    method: 'PATCH', headers: getHeaders(), body: JSON.stringify({ status })
  });
  loadStats();
}

async function cancelAppt(id) {
  if (!confirm('Cancel this appointment?')) return;
  await fetch(`/api/appointments/${id}/cancel`, { method: 'POST', headers: getHeaders() });
  loadAppointments(); loadStats();
}

async function completeAppt(id) {
  await fetch(`/api/appointments/${id}/complete`, { method: 'POST', headers: getHeaders() });
  loadAppointments(); loadStats();
}

async function checkCalendarStatus() {
  try {
    const res  = await fetch('/api/calendar/status', { headers: getHeaders() });
    const data = await res.json();
    const statusEl   = document.getElementById('cal-status');
    const actionsEl  = document.getElementById('cal-actions');
    const selectorEl = document.getElementById('cal-selector');

    if (!data.configured) {
      // Credentials not in env — show setup instructions, no connect button
      statusEl.innerHTML  = '<div class="cal-dot off"></div><span style="color:var(--muted);font-size:13px">Not Configured</span>';
      actionsEl.innerHTML = '<p style="font-size:12px;color:var(--muted);line-height:1.6;margin:0;">Add <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, and <code>GOOGLE_REDIRECT_URI</code> to your Render environment variables, then redeploy to enable Google Calendar sync.</p>';
      return;
    }

    if (data.connected) {
      statusEl.innerHTML  = `<div class="cal-dot on"></div><span style="color:#6fbf73;font-size:13px">Connected</span>${data.calendarId ? `<span style="color:var(--muted);font-size:12px;margin-left:8px">(${data.calendarId})</span>` : ''}`;
      actionsEl.innerHTML = '<button class="connect-btn" id="connect-gcal">Reconnect</button>';
      if (!data.calendarId) { loadCalendarList(); selectorEl.style.display = ''; }
    } else {
      statusEl.innerHTML  = '<div class="cal-dot off"></div><span style="color:var(--amber);font-size:13px">Not Connected</span>';
      actionsEl.innerHTML = '<button class="connect-btn" id="connect-gcal">Connect Google Calendar</button>';
    }
    document.getElementById('connect-gcal').addEventListener('click', connectGCal);
  } catch {}
}

async function connectGCal() {
  try {
    const res  = await fetch('/api/calendar/auth-url', { headers: getHeaders() });
    const data = await res.json();
    if (data.url)   { window.location.href = data.url; }
    else if (data.error) { showAlert(data.error, 'error'); }
  } catch { showAlert('Failed to start Google Calendar connection', 'error'); }
}

async function loadCalendarList() {
  try {
    const res  = await fetch('/api/calendar/calendars', { headers: getHeaders() });
    const data = await res.json();
    const select = document.getElementById('cal-select');
    select.innerHTML = '<option value="">Choose a calendar...</option>' +
      data.calendars.map(c => `<option value="${c.id}">${esc(c.summary)}${c.primary ? ' (Primary)' : ''}</option>`).join('');
    document.getElementById('cal-selector').style.display = '';
  } catch {}
}

document.getElementById('save-cal').addEventListener('click', async () => {
  const calId = document.getElementById('cal-select').value;
  if (!calId) return;
  await fetch('/api/calendar/set-calendar', {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ calendarId: calId })
  });
  showAlert('Calendar selected successfully!', 'success');
  checkCalendarStatus();
});

async function loadSettings() {
  try {
    const res = await fetch(`${API}/settings`, { headers: getHeaders() });
    const { settings } = await res.json();
    if (settings.working_hours_start) document.getElementById('set-start').value    = settings.working_hours_start;
    if (settings.working_hours_end)   document.getElementById('set-end').value      = settings.working_hours_end;
    if (settings.slot_duration)       document.getElementById('set-duration').value = settings.slot_duration;
    if (settings.booking_lead_hours)  document.getElementById('set-lead').value     = settings.booking_lead_hours;
    if (settings.working_days) {
      const days = settings.working_days.split(',');
      document.querySelectorAll('#working-days input').forEach(cb => { cb.checked = days.includes(cb.value); });
    }
  } catch {}
}

document.getElementById('save-settings').addEventListener('click', async () => {
  const btn = document.getElementById('save-settings');
  btn.disabled = true; btn.textContent = 'Saving...';
  const workingDays = Array.from(document.querySelectorAll('#working-days input:checked')).map(cb => cb.value).join(',');
  await fetch(`${API}/settings`, {
    method: 'PUT', headers: getHeaders(),
    body: JSON.stringify({
      working_hours_start: document.getElementById('set-start').value,
      working_hours_end:   document.getElementById('set-end').value,
      slot_duration:       document.getElementById('set-duration').value,
      working_days:        workingDays,
      booking_lead_hours:  document.getElementById('set-lead').value
    })
  });
  btn.disabled = false; btn.textContent = 'Save Settings';
  showAlert('Settings saved successfully!', 'success');
});

document.getElementById('export-csv').addEventListener('click', async () => {
  const res = await fetch(`${API}/subscribers`, { headers: getHeaders() });
  const { subscribers } = await res.json();
  const csv = 'Name,Email,Source,Date\n' + subscribers.map(s =>
    `"${s.name}","${s.email}","${s.source}","${s.subscribed_at}"`
  ).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'theanirudhcode-subscribers.csv';
  a.click();
});

function showAlert(msg, type) {
  const area = document.getElementById('alert-area');
  if (!area) return;
  area.innerHTML = `<div class="alert-box alert-${type}">${esc(msg)}</div>`;
  setTimeout(() => { area.innerHTML = ''; }, 5000);
}

function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
