const API = '/portal-management/api';

const loginScreen = document.getElementById('login-screen');
const dashboard   = document.getElementById('dashboard');
const loginBtn    = document.getElementById('login-btn');
const loginUser   = document.getElementById('login-user');
const loginPass   = document.getElementById('login-pass');
const loginError  = document.getElementById('login-error');
const logoutBtn   = document.getElementById('logout-btn');

const params = new URLSearchParams(window.location.search);
if (params.get('calendar_success')) showAlert(params.get('calendar_success'), 'success');
if (params.get('calendar_error'))   showAlert(params.get('calendar_error'), 'error');
if (params.get('calendar_success') || params.get('calendar_error')) {
  history.replaceState({}, '', '/portal-management');
}

// Try cookie-based admin session (admin_token set by /portal-management/api/login)
trySessionLoad();

loginBtn.addEventListener('click', login);
loginPass.addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
loginUser.addEventListener('keydown', e => { if (e.key === 'Enter') loginPass.focus(); });
logoutBtn.addEventListener('click', async () => {
  try { await fetch(`${API}/logout`, { method: 'POST', credentials: 'same-origin' }); } catch {}
  window.location.href = '/portal-management';
});

// Event delegation — replaces all inline onclick/onchange in generated table HTML
document.addEventListener('click', e => {
  if (e.target.matches('[data-action="delete-sub"]'))      deleteSub(parseInt(e.target.dataset.id));
  if (e.target.matches('[data-action="cancel-appt"]'))     cancelAppt(parseInt(e.target.dataset.id));
  if (e.target.matches('[data-action="complete-appt"]'))   completeAppt(parseInt(e.target.dataset.id));
  if (e.target.matches('[data-action="reply-consult"]'))   openReplyModal(parseInt(e.target.dataset.id), e.target.dataset.name, e.target.dataset.email);
  if (e.target.matches('[data-action="edit-post"]'))       openEditPost(parseInt(e.target.dataset.id));
  if (e.target.matches('[data-action="delete-post"]'))     deletePost(parseInt(e.target.dataset.id));
  if (e.target.matches('[data-action="toggle-post"]'))     togglePost(parseInt(e.target.dataset.id), e.target.dataset.published === 'true');
  if (e.target.matches('[data-action="block-slot"]'))      blockSlot(e.target);
  if (e.target.matches('[data-action="unblock-slot"]'))    unblockSlot(e.target);
});
document.addEventListener('change', e => {
  if (e.target.matches('[data-action="update-status"]')) updateStatus(parseInt(e.target.dataset.id), e.target.value);
});

// Check if admin_token cookie is valid by hitting a protected endpoint
async function trySessionLoad() {
  try {
    const res = await fetch(`${API}/stats`, { credentials: 'same-origin' });
    if (res.ok) { showDashboard(); return; }
  } catch {}
}

async function login() {
  const username = (loginUser.value || '').trim();
  const password = loginPass.value;
  loginError.style.display = 'none';
  loginBtn.disabled = true;
  loginBtn.textContent = 'Verifying…';

  try {
    const res = await fetch(`${API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username, password })
    });
    if (res.ok) {
      showDashboard();
      return;
    }
    const data = await res.json().catch(() => ({}));
    loginError.textContent = data.error || 'Invalid credentials';
  } catch {
    loginError.textContent = 'Network error — try again';
  }

  loginError.style.display = 'block';
  loginBtn.disabled = false;
  loginBtn.textContent = 'Access Dashboard';
}

function getHeaders() {
  return { 'Content-Type': 'application/json' };
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
  loadPosts();
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
    if (btn.dataset.view === 'calendar') loadSlots();
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
    <td><button class="action-btn" data-action="reply-consult" data-id="${c.id}" data-name="${esc(c.name)}" data-email="${esc(c.email)}">${c.admin_reply ? 'Re-reply' : 'Reply'}</button></td>
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

// ── Reply Modal ────────────────────────────────────────────────────────────
let replyConsultId = null;

function openReplyModal(id, name, email) {
  replyConsultId = id;
  document.getElementById('reply-modal-to').textContent = `To: ${name} (${email})`;
  document.getElementById('reply-text').value = '';
  document.getElementById('reply-modal').classList.add('open');
  document.getElementById('reply-text').focus();
}

function closeReplyModal() {
  document.getElementById('reply-modal').classList.remove('open');
  replyConsultId = null;
}

document.getElementById('reply-modal-close').addEventListener('click', closeReplyModal);
document.getElementById('reply-cancel-btn').addEventListener('click', closeReplyModal);
document.getElementById('reply-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeReplyModal(); });

document.getElementById('reply-send-btn').addEventListener('click', async () => {
  const reply = document.getElementById('reply-text').value.trim();
  if (!reply) return;
  const btn = document.getElementById('reply-send-btn');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res = await fetch(`${API}/consultations/${replyConsultId}/reply`, {
      method: 'POST', headers: getHeaders(), body: JSON.stringify({ reply })
    });
    if (res.ok) {
      closeReplyModal();
      showAlert('Reply sent successfully!', 'success');
      loadConsultations();
    } else {
      const d = await res.json();
      showAlert(d.error || 'Failed to send reply', 'error');
    }
  } catch { showAlert('Connection error', 'error'); }
  btn.disabled = false; btn.textContent = 'Send Reply';
});

// ── Blog CMS ───────────────────────────────────────────────────────────────
async function loadPosts() {
  try {
    const res = await fetch(`${API}/posts`, { headers: getHeaders() });
    const { posts } = await res.json();
    const body = document.getElementById('posts-body');
    if (!posts || !posts.length) { body.innerHTML = '<tr><td colspan="5" class="empty">No posts yet</td></tr>'; return; }
    body.innerHTML = posts.map(p => `<tr>
      <td>${esc(p.title)}</td>
      <td>${esc(p.category)}</td>
      <td class="${p.published ? 'post-published' : 'post-draft'}">${p.published ? 'Published' : 'Draft'}</td>
      <td>${new Date(p.createdAt).toLocaleDateString()}</td>
      <td>
        <button class="action-btn" data-action="edit-post" data-id="${p.id}">Edit</button>
        <button class="action-btn" data-action="toggle-post" data-id="${p.id}" data-published="${p.published}">${p.published ? 'Unpublish' : 'Publish'}</button>
        <button class="action-btn danger" data-action="delete-post" data-id="${p.id}">Delete</button>
      </td>
    </tr>`).join('');
  } catch {}
}

document.getElementById('new-post-btn').addEventListener('click', () => openPostModal(null));

function openPostModal(post) {
  document.getElementById('post-edit-id').value = post ? post.id : '';
  document.getElementById('post-modal-title').textContent = post ? 'Edit Post' : 'New Post';
  document.getElementById('post-title').value    = post ? post.title    : '';
  document.getElementById('post-slug').value     = post ? post.slug     : '';
  document.getElementById('post-category').value = post ? post.category : '';
  document.getElementById('post-canvas').value   = post ? (post.canvasType || 'gut') : 'gut';
  document.getElementById('post-tags').value     = post ? (post.tags || '') : '';
  document.getElementById('post-excerpt').value  = post ? post.excerpt  : '';
  document.getElementById('post-content').value  = post ? post.content  : '';
  document.getElementById('post-published').checked = post ? post.published : true;
  document.getElementById('post-modal').classList.add('open');
}

function closePostModal() { document.getElementById('post-modal').classList.remove('open'); }

document.getElementById('post-modal-close').addEventListener('click', closePostModal);
document.getElementById('post-cancel-btn').addEventListener('click', closePostModal);
document.getElementById('post-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closePostModal(); });

document.getElementById('post-save-btn').addEventListener('click', async () => {
  const id       = document.getElementById('post-edit-id').value;
  const payload  = {
    title:      document.getElementById('post-title').value.trim(),
    slug:       document.getElementById('post-slug').value.trim(),
    category:   document.getElementById('post-category').value.trim(),
    canvasType: document.getElementById('post-canvas').value,
    tags:       document.getElementById('post-tags').value.trim(),
    excerpt:    document.getElementById('post-excerpt').value.trim(),
    content:    document.getElementById('post-content').value.trim(),
    published:  document.getElementById('post-published').checked,
  };
  if (!payload.title || !payload.category || !payload.excerpt || !payload.content) {
    showAlert('Title, category, excerpt, and content are required', 'error'); return;
  }
  const btn = document.getElementById('post-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch(id ? `${API}/posts/${id}` : `${API}/posts`, {
      method: id ? 'PUT' : 'POST', headers: getHeaders(), body: JSON.stringify(payload)
    });
    if (res.ok) {
      closePostModal();
      showAlert(id ? 'Post updated!' : 'Post created!', 'success');
      loadPosts();
    } else {
      const d = await res.json();
      showAlert(d.error || 'Failed to save post', 'error');
    }
  } catch { showAlert('Connection error', 'error'); }
  btn.disabled = false; btn.textContent = 'Save Post';
});

async function openEditPost(id) {
  try {
    const res = await fetch(`${API}/posts`, { headers: getHeaders() });
    const { posts } = await res.json();
    const post = posts.find(p => p.id === id);
    if (!post) return;
    // fetch full post content for editing
    const fullRes = await fetch(`/api/posts/${post.slug}`);
    const fullData = await fullRes.json();
    openPostModal({ ...post, content: fullData.post?.content || '', excerpt: fullData.post?.excerpt || post.excerpt });
  } catch {}
}

async function deletePost(id) {
  if (!confirm('Delete this post permanently?')) return;
  await fetch(`${API}/posts/${id}`, { method: 'DELETE', headers: getHeaders() });
  loadPosts();
}

async function togglePost(id, currentlyPublished) {
  await fetch(`${API}/posts/${id}`, {
    method: 'PUT', headers: getHeaders(),
    body: JSON.stringify({ published: !currentlyPublished })
  });
  loadPosts();
}

// ── Slot Manager ────────────────────────────────────────────────────────────────

// Set default date to today when page loads
(function() {
  const inp = document.getElementById('slot-date');
  if (inp) inp.value = new Date().toISOString().split('T')[0];
})();

document.getElementById('load-slots-btn').addEventListener('click', loadSlots);
document.getElementById('slot-date').addEventListener('change', loadSlots);

async function loadSlots() {
  const date = document.getElementById('slot-date').value;
  if (!date) return;

  const grid = document.getElementById('slot-grid');
  grid.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px 0">Loading slots…</p>';

  try {
    const res  = await fetch(`/api/calendar/admin/slots?date=${date}`, { headers: getHeaders() });
    const data = await res.json();

    if (!data.slots || !data.slots.length) {
      grid.innerHTML = '<p style="color:var(--faint);font-size:13px;font-style:italic;padding:8px 0">No slots for this day — it may be a non-working day. Check Settings.</p>';
      return;
    }

    const statusMap = {
      available: { color: '#6fbf73', label: 'Open',     border: 'rgba(111,191,115,.25)' },
      booked:    { color: 'var(--gold)', label: 'Booked',   border: 'rgba(200,169,81,.3)' },
      blocked:   { color: 'var(--amber)', label: 'Closed',  border: 'rgba(200,115,58,.3)' },
      'gcal-busy': { color: 'var(--muted)', label: 'External', border: 'var(--line)' }
    };

    const cards = data.slots.map(slot => {
      const sm = statusMap[slot.status] || statusMap.available;
      const extra = slot.status === 'booked'   ? ` — ${esc(slot.patient || 'Patient')}`
                  : slot.status === 'gcal-busy' ? ' (Google Cal)'
                  : '';

      let btnHtml = '';
      if (slot.status === 'available') {
        btnHtml = `<button class="action-btn"
          style="margin-top:8px;border-color:rgba(200,115,58,.4);color:var(--amber);font-size:10px;width:100%"
          data-action="block-slot"
          data-date="${date}" data-start="${slot.start}" data-end="${slot.end}">Close Slot</button>`;
      } else if (slot.status === 'blocked') {
        btnHtml = `<button class="action-btn"
          style="margin-top:8px;border-color:rgba(111,191,115,.4);color:#6fbf73;font-size:10px;width:100%"
          data-action="unblock-slot"
          data-date="${date}" data-start="${slot.start}">Open Slot</button>`;
      }

      return `<div style="background:var(--black2);border:1px solid ${sm.border};padding:14px 16px;display:flex;flex-direction:column">
        <div style="font-size:14px;color:var(--white);margin-bottom:3px;font-family:'Tenor Sans',sans-serif;letter-spacing:.04em">${slot.start}–${slot.end}</div>
        <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${sm.color}">${sm.label}${extra}</div>
        ${btnHtml}
      </div>`;
    }).join('');

    grid.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px">${cards}</div>`;

    if (!data.gcalConnected) {
      grid.insertAdjacentHTML('afterbegin', '<p style="font-size:11px;color:var(--faint);margin-bottom:12px;letter-spacing:.04em">Google Calendar not connected — slot changes are saved in the database only.</p>');
    }
  } catch {
    grid.innerHTML = '<p style="color:var(--amber);font-size:13px">Failed to load slots. Check connection.</p>';
  }
}

async function blockSlot(btn) {
  const { date, start: timeStart, end: timeEnd } = btn.dataset;
  btn.disabled = true; btn.textContent = 'Closing…';
  try {
    const res = await fetch('/api/calendar/admin/block', {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({ date, timeStart, timeEnd })
    });
    if (res.ok) {
      loadSlots();
    } else {
      const d = await res.json();
      showAlert(d.error || 'Failed to close slot', 'error');
      btn.disabled = false; btn.textContent = 'Close Slot';
    }
  } catch {
    btn.disabled = false; btn.textContent = 'Close Slot';
  }
}

async function unblockSlot(btn) {
  const { date, start: timeStart } = btn.dataset;
  btn.disabled = true; btn.textContent = 'Opening…';
  try {
    const res = await fetch('/api/calendar/admin/unblock', {
      method: 'DELETE', headers: getHeaders(),
      body: JSON.stringify({ date, timeStart })
    });
    if (res.ok) {
      loadSlots();
    } else {
      const d = await res.json();
      showAlert(d.error || 'Failed to open slot', 'error');
      btn.disabled = false; btn.textContent = 'Open Slot';
    }
  } catch {
    btn.disabled = false; btn.textContent = 'Open Slot';
  }
}
