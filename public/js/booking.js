/* ═══════════════════════════════════════
   MULTI-STEP BOOKING MODAL
   5-step flow: Tier → Date → Time → Details → Confirm
═══════════════════════════════════════ */

const CONSULTATION_TIERS = {
  discovery: {
    key:      'discovery',
    label:    '30-min Discovery',
    duration: '30 minutes',
    price:    1500,
    badge:    null,
    desc:     'Ideal for first-timers. A focused conversation to map your health story and identify root causes.',
    includes: ['Root cause mapping', 'Priority health concerns review', 'Protocol direction', 'Supplement overview'],
  },
  deepdive: {
    key:      'deepdive',
    label:    '60-min Deep Dive',
    duration: '60 minutes',
    price:    5000,
    badge:    'Most Popular',
    desc:     'The complete diagnostic consultation. We go deep — metabolic, hormonal, gut, and lifestyle — and build your initial protocol.',
    includes: ['Full root cause mapping', 'Personalised nutrition plan', 'Fasting protocol', 'Supplement & lab review'],
  },
  comprehensive: {
    key:      'comprehensive',
    label:    '90-min Comprehensive',
    duration: '90 minutes',
    price:    8000,
    badge:    'Best Outcome',
    desc:     'For complex, chronic, or multi-system conditions. The deepest single session available — with a written protocol delivered within 48 hours.',
    includes: ['Everything in Deep Dive', 'Written protocol report (48h)', 'Dosha & metabolic profiling', '2-week follow-up message'],
  },
};

class BookingModal {
  constructor() {
    this.step = 0;
    this.selectedTier = null;
    this.selectedDate = null;
    this.selectedSlot = null;
    this.healthData = {};
    this.availableDays = [];
    this.currentMonth = null;
    this.modal = document.getElementById('consultation-modal');
    this.container = document.getElementById('booking-container');
  }

  open() {
    if (!Auth.isLoggedIn()) {
      this.showLoginPrompt();
      this.modal.classList.add('open');
      document.body.style.overflow = 'hidden';
      return;
    }
    this.step = 0;
    this.selectedTier = null;
    this.selectedDate = null;
    this.selectedSlot = null;
    this.healthData = {};
    const now = new Date();
    this.currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    this.render();
    this.modal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  close() {
    this.modal.classList.remove('open');
    document.body.style.overflow = '';
  }

  showLoginPrompt() {
    this.close();
    if (window.openAuthModal) window.openAuthModal();
  }

  render() {
    const steps = ['Choose Type', 'Select Date', 'Choose Time', 'Health Details', 'Confirm'];
    const dots = steps.map((s, i) => {
      const cls = i < this.step ? 'completed' : i === this.step ? 'active' : '';
      return `<div class="booking-step">
        <div class="booking-step-dot ${cls}">${i < this.step ? '&#10003;' : i + 1}</div>
        <span class="booking-step-label ${cls}">${s}</span>
      </div>`;
    }).join('');

    this.container.innerHTML = `
      <div class="booking-steps">${dots}</div>
      <div id="booking-step-content"></div>`;

    const content = document.getElementById('booking-step-content');
    if (this.step === 0) this.renderTierStep(content);
    else if (this.step === 1) this.renderDateStep(content);
    else if (this.step === 2) this.renderTimeStep(content);
    else if (this.step === 3) this.renderHealthStep(content);
    else if (this.step === 4) this.renderConfirmStep(content);
  }

  renderTierStep(el) {
    const tiers = Object.values(CONSULTATION_TIERS);
    el.innerHTML = `
      <div class="gl" style="margin-bottom:6px">Step 1</div>
      <h3 class="booking-title">Choose Your Consultation</h3>
      <p class="booking-desc">Select the session that fits your needs</p>
      <div class="tier-grid">
        ${tiers.map(t => `
          <div class="tier-card${this.selectedTier === t.key ? ' selected' : ''}" data-tier="${t.key}">
            ${t.badge ? `<div class="tier-badge">${t.badge}</div>` : ''}
            <div class="tier-duration">${t.duration}</div>
            <div class="tier-name">${t.label}</div>
            <div class="tier-price">₹${t.price.toLocaleString('en-IN')}</div>
            <p class="tier-desc">${t.desc}</p>
            <ul class="tier-includes">
              ${t.includes.map(item => `<li>${item}</li>`).join('')}
            </ul>
            <button class="tier-select-btn${this.selectedTier === t.key ? ' chosen' : ''}" data-tier="${t.key}">
              ${this.selectedTier === t.key ? '✓ Selected' : 'Select'}
            </button>
          </div>`).join('')}
      </div>`;

    el.querySelectorAll('.tier-card, .tier-select-btn').forEach(el => {
      el.addEventListener('click', (e) => {
        const key = e.currentTarget.dataset.tier;
        this.selectedTier = key;
        this.step = 1;
        this.render();
      });
    });
  }

  async renderDateStep(el) {
    const tier = CONSULTATION_TIERS[this.selectedTier];
    el.innerHTML = `
      <div class="gl" style="margin-bottom:6px">Step 2</div>
      <h3 class="booking-title">Select a Date</h3>
      <p class="booking-desc">${tier.label} · ₹${tier.price.toLocaleString('en-IN')}</p>
      <div id="calendar-loader" style="text-align:center;padding:40px 0;color:var(--muted)">Loading calendar...</div>
      <div id="calendar-grid" style="display:none"></div>
      <div class="booking-nav">
        <button class="btn-o booking-back" id="step-back"><span>&larr; Back</span></button>
      </div>`;

    document.getElementById('step-back').addEventListener('click', () => { this.step = 0; this.render(); });
    await this.loadMonth();
  }

  async loadMonth() {
    const grid = document.getElementById('calendar-grid');
    const loader = document.getElementById('calendar-loader');

    try {
      const res = await fetch(`/api/calendar/available-days?month=${this.currentMonth}`);
      const data = await res.json();
      this.availableDays = data.days;

      const [year, month] = this.currentMonth.split('-').map(Number);
      const monthName = new Date(year, month - 1).toLocaleString('en', { month: 'long', year: 'numeric' });

      grid.innerHTML = `
        <div class="cal-header">
          <button class="cal-nav" id="cal-prev">&larr;</button>
          <span class="cal-month">${monthName}</span>
          <button class="cal-nav" id="cal-next">&rarr;</button>
        </div>
        <div class="cal-days-header">
          ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="cal-day-name">${d}</div>`).join('')}
        </div>
        <div class="cal-grid" id="cal-cells"></div>`;

      const cells = document.getElementById('cal-cells');
      const firstDay = new Date(year, month - 1, 1).getDay();
      const daysInMonth = new Date(year, month, 0).getDate();

      for (let i = 0; i < firstDay; i++) {
        cells.innerHTML += `<div class="cal-cell empty"></div>`;
      }

      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${this.currentMonth}-${String(d).padStart(2, '0')}`;
        const dayData = this.availableDays.find(x => x.date === dateStr);
        const hasSlots = dayData && dayData.hasSlots;
        const isSelected = this.selectedDate === dateStr;

        const cls = isSelected ? 'selected' : hasSlots ? 'available' : 'disabled';
        cells.innerHTML += `<div class="cal-cell ${cls}" data-date="${dateStr}">${d}</div>`;
      }

      cells.querySelectorAll('.cal-cell.available, .cal-cell.selected').forEach(cell => {
        cell.addEventListener('click', () => {
          this.selectedDate = cell.dataset.date;
          this.selectedSlot = null;
          this.step = 2;
          this.render();
        });
      });

      document.getElementById('cal-prev').addEventListener('click', () => {
        const [y, m] = this.currentMonth.split('-').map(Number);
        const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
        this.currentMonth = prev;
        this.loadMonth();
      });

      document.getElementById('cal-next').addEventListener('click', () => {
        const [y, m] = this.currentMonth.split('-').map(Number);
        const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
        this.currentMonth = next;
        this.loadMonth();
      });

      loader.style.display = 'none';
      grid.style.display = 'block';
    } catch (err) {
      loader.textContent = 'Failed to load calendar. Please try again.';
    }
  }

  async renderTimeStep(el) {
    const tier = CONSULTATION_TIERS[this.selectedTier];
    const dateObj = new Date(this.selectedDate + 'T00:00:00');
    const dateLabel = dateObj.toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    el.innerHTML = `
      <div class="gl" style="margin-bottom:6px">Step 3</div>
      <h3 class="booking-title">Choose a Time Slot</h3>
      <p class="booking-desc">${dateLabel} · ${tier.label}</p>
      <div id="slots-loader" style="text-align:center;padding:40px 0;color:var(--muted)">Loading available slots...</div>
      <div id="slots-grid" class="booking-slots" style="display:none"></div>
      <div class="booking-nav">
        <button class="btn-o booking-back" id="step-back"><span>&larr; Back</span></button>
      </div>`;

    document.getElementById('step-back').addEventListener('click', () => { this.step = 1; this.render(); });

    try {
      const res = await fetch(`/api/calendar/available-slots?date=${this.selectedDate}`);
      const data = await res.json();

      const grid = document.getElementById('slots-grid');
      const loader = document.getElementById('slots-loader');

      if (!data.slots || data.slots.length === 0) {
        loader.textContent = 'No time slots available on this date.';
        return;
      }

      const availableSlots = data.slots.filter(s => s.available);
      if (availableSlots.length === 0) {
        loader.textContent = 'All slots are booked on this date. Please choose another day.';
        return;
      }

      data.slots.forEach(slot => {
        const cls = slot.available ? 'available' : 'booked';
        const startH = parseInt(slot.start.split(':')[0]);
        const ampm = startH >= 12 ? 'PM' : 'AM';
        const displayH = startH > 12 ? startH - 12 : (startH === 0 ? 12 : startH);
        const endH = parseInt(slot.end.split(':')[0]);
        const endAmpm = endH >= 12 ? 'PM' : 'AM';
        const displayEndH = endH > 12 ? endH - 12 : (endH === 0 ? 12 : endH);

        grid.innerHTML += `
          <div class="booking-slot ${cls}" data-start="${slot.start}" data-end="${slot.end}">
            <div class="slot-time">${displayH}:${slot.start.split(':')[1]} ${ampm}</div>
            <div class="slot-end">${displayEndH}:${slot.end.split(':')[1]} ${endAmpm}</div>
            ${!slot.available ? '<div class="slot-booked">Booked</div>' : ''}
          </div>`;
      });

      grid.querySelectorAll('.booking-slot.available').forEach(slot => {
        slot.addEventListener('click', () => {
          grid.querySelectorAll('.booking-slot').forEach(s => s.classList.remove('selected'));
          slot.classList.add('selected');
          this.selectedSlot = { start: slot.dataset.start, end: slot.dataset.end };
          this.step = 3;
          this.render();
        });
      });

      loader.style.display = 'none';
      grid.style.display = 'grid';
    } catch {
      document.getElementById('slots-loader').textContent = 'Failed to load time slots.';
    }
  }

  renderHealthStep(el) {
    const tier = CONSULTATION_TIERS[this.selectedTier];
    const dateObj = new Date(this.selectedDate + 'T00:00:00');
    const dateLabel = dateObj.toLocaleDateString('en', { month: 'short', day: 'numeric' });
    const startH = parseInt(this.selectedSlot.start.split(':')[0]);
    const ampm = startH >= 12 ? 'PM' : 'AM';
    const displayH = startH > 12 ? startH - 12 : startH;
    const timeLabel = `${displayH}:${this.selectedSlot.start.split(':')[1]} ${ampm}`;

    el.innerHTML = `
      <div class="gl" style="margin-bottom:6px">Step 4</div>
      <h3 class="booking-title">Your Health Details</h3>
      <p class="booking-desc">${tier.label} · ${dateLabel} at ${timeLabel}</p>
      <form id="health-form">
        <label class="finput-label">Health Concerns <span style="color:var(--amber)">*</span></label>
        <textarea class="finput" name="health_concerns" rows="3" placeholder="Describe your current health issues, symptoms, or conditions..." required>${this.healthData.health_concerns || ''}</textarea>
        <label class="finput-label">Medical History</label>
        <textarea class="finput" name="medical_history" rows="2" placeholder="Any previous diagnoses, surgeries, ongoing treatments...">${this.healthData.medical_history || ''}</textarea>
        <label class="finput-label">Wellness Goals</label>
        <textarea class="finput" name="goals" rows="2" placeholder="What would you like to achieve from this consultation?">${this.healthData.goals || ''}</textarea>
        <div class="booking-nav">
          <button type="button" class="btn-o booking-back" id="step-back"><span>&larr; Back</span></button>
          <button type="submit" class="btn-g booking-next"><span>Review &rarr;</span></button>
        </div>
      </form>`;

    document.getElementById('step-back').addEventListener('click', () => { this.step = 2; this.render(); });

    document.getElementById('health-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      this.healthData = Object.fromEntries(fd);
      if (!this.healthData.health_concerns || !this.healthData.health_concerns.trim()) {
        if (typeof Toast !== 'undefined') Toast.error('Please describe your health concerns');
        return;
      }
      this.step = 4;
      this.render();
    });
  }

  renderConfirmStep(el) {
    const tier = CONSULTATION_TIERS[this.selectedTier];
    const dateObj = new Date(this.selectedDate + 'T00:00:00');
    const dateLabel = dateObj.toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const startH = parseInt(this.selectedSlot.start.split(':')[0]);
    const ampm = startH >= 12 ? 'PM' : 'AM';
    const displayH = startH > 12 ? startH - 12 : startH;
    const endH = parseInt(this.selectedSlot.end.split(':')[0]);
    const endAmpm = endH >= 12 ? 'PM' : 'AM';
    const displayEndH = endH > 12 ? endH - 12 : endH;
    const timeLabel = `${displayH}:${this.selectedSlot.start.split(':')[1]} ${ampm} — ${displayEndH}:${this.selectedSlot.end.split(':')[1]} ${endAmpm}`;

    el.innerHTML = `
      <div class="gl" style="margin-bottom:6px">Step 5</div>
      <h3 class="booking-title">Confirm Your Appointment</h3>
      <p class="booking-desc">Please review your details before confirming</p>

      <div class="confirm-card">
        <div class="confirm-row">
          <span class="confirm-label">Patient</span>
          <span class="confirm-value">${Auth.user.name}</span>
        </div>
        <div class="confirm-row">
          <span class="confirm-label">Session</span>
          <span class="confirm-value" style="color:var(--gold2)">${tier.label}</span>
        </div>
        <div class="confirm-row">
          <span class="confirm-label">Fee</span>
          <span class="confirm-value">₹${tier.price.toLocaleString('en-IN')}</span>
        </div>
        <div class="confirm-row">
          <span class="confirm-label">Date</span>
          <span class="confirm-value">${dateLabel}</span>
        </div>
        <div class="confirm-row">
          <span class="confirm-label">Time</span>
          <span class="confirm-value">${timeLabel}</span>
        </div>
        <div class="confirm-row">
          <span class="confirm-label">Concerns</span>
          <span class="confirm-value">${this.healthData.health_concerns}</span>
        </div>
        ${this.healthData.medical_history ? `<div class="confirm-row"><span class="confirm-label">History</span><span class="confirm-value">${this.healthData.medical_history}</span></div>` : ''}
        ${this.healthData.goals ? `<div class="confirm-row"><span class="confirm-label">Goals</span><span class="confirm-value">${this.healthData.goals}</span></div>` : ''}
      </div>
      <p style="font-size:12px;color:var(--faint);margin-top:12px;line-height:1.7">Payment of ₹${tier.price.toLocaleString('en-IN')} is collected before the session. You will receive payment details via WhatsApp/email after booking.</p>

      <div class="booking-nav">
        <button class="btn-o booking-back" id="step-back"><span>&larr; Back</span></button>
        <button class="btn-g booking-confirm" id="confirm-btn"><span>Confirm Booking &check;</span></button>
      </div>`;

    document.getElementById('step-back').addEventListener('click', () => { this.step = 3; this.render(); });
    document.getElementById('confirm-btn').addEventListener('click', () => this.submitBooking());
  }

  async submitBooking() {
    const btn = document.getElementById('confirm-btn');
    const span = btn.querySelector('span');
    btn.disabled = true;
    span.textContent = 'Booking...';
    btn.style.opacity = '0.7';

    const tier = CONSULTATION_TIERS[this.selectedTier];

    try {
      const res = await fetch('/api/appointments/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date:              this.selectedDate,
          time_start:        this.selectedSlot.start,
          time_end:          this.selectedSlot.end,
          consultation_type: this.selectedTier,
          health_concerns:   this.healthData.health_concerns,
          medical_history:   this.healthData.medical_history || '',
          goals:             this.healthData.goals || ''
        })
      });
      const data = await res.json();

      if (res.ok) {
        if (typeof Toast !== 'undefined') Toast.success('Appointment booked! Check WhatsApp/email for payment details.');
        this.container.innerHTML = `
          <div style="text-align:center;padding:40px 0">
            <div style="font-size:48px;margin-bottom:16px;color:var(--gold)">&#10003;</div>
            <h3 style="font-family:'Cormorant',serif;font-size:clamp(24px,3vw,36px);font-weight:300;margin-bottom:12px">
              Appointment <em style="color:var(--gold2)">Confirmed</em>
            </h3>
            <p style="color:var(--muted);font-size:var(--fb);margin-bottom:8px;font-weight:200">
              ${tier.label} · ₹${tier.price.toLocaleString('en-IN')}
            </p>
            <p style="color:var(--faint);font-size:13px;margin-bottom:24px">
              Payment details will be sent to your WhatsApp/email within 15 minutes.
            </p>
            <div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap">
              <a href="/my-appointments" class="btn-g" style="text-decoration:none;display:inline-flex;padding:14px 32px"><span>View My Appointments</span></a>
              <button class="btn-o" onclick="bookingModal.close()"><span>Close</span></button>
            </div>
          </div>`;
      } else {
        if (typeof Toast !== 'undefined') Toast.error(data.error || 'Booking failed');
        btn.disabled = false;
        span.textContent = 'Confirm Booking \u2713';
        btn.style.opacity = '';
      }
    } catch {
      if (typeof Toast !== 'undefined') Toast.error('Connection error. Please try again.');
      btn.disabled = false;
      span.textContent = 'Confirm Booking \u2713';
      btn.style.opacity = '';
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.bookingModal = new BookingModal();

  if (window.location.search.includes('booking=open')) {
    history.replaceState({}, '', window.location.pathname);
    const tryOpen = () => {
      if (window.bookingModal) window.bookingModal.open();
    };
    document.addEventListener('auth:ready', tryOpen, { once: true });
    setTimeout(tryOpen, 800);
  }
});
