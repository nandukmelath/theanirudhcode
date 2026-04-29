/* ═══════════════════════════════════════
   MULTI-STEP BOOKING MODAL
   5-step flow: Tier → Date → Time → Details → Confirm
═══════════════════════════════════════ */

const CONSULTATION_TIERS = {
  discovery: {
    key:      'discovery',
    label:    '30-min Discovery',
    duration: '30 minutes',
    badge:    null,
    desc:     'Ideal for first-timers. A focused conversation to map your health story and identify root causes.',
    includes: ['Root cause mapping', 'Priority health concerns review', 'Protocol direction', 'Supplement overview'],
  },
  deepdive: {
    key:      'deepdive',
    label:    '60-min Deep Dive',
    duration: '60 minutes',
    badge:    'Most Popular',
    desc:     'The complete diagnostic consultation. We go deep — metabolic, hormonal, gut, and lifestyle — and build your initial protocol.',
    includes: ['Full root cause mapping', 'Personalised nutrition plan', 'Fasting protocol', 'Supplement & lab review'],
  },
  comprehensive: {
    key:      'comprehensive',
    label:    '90-min Comprehensive',
    duration: '90 minutes',
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

    // Scroll modal to top on every step change
    const mc = this.modal && this.modal.querySelector('.modal-content');
    if (mc) mc.scrollTop = 0;

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
      <p class="booking-desc">${tier.label}</p>
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

    // \u2500\u2500 Detect currency by timezone \u2500\u2500
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const isIndia = tz === 'Asia/Calcutta' || tz === 'Asia/Kolkata';
    this._currency = this._currency || (isIndia ? 'INR' : 'USD');
    const currency = this._currency;

    const TIER_PRICES = {
      discovery:     { INR: 1500,  USD: 18  },
      deepdive:      { INR: 5000,  USD: 60  },
      comprehensive: { INR: 8000,  USD: 96  },
    };
    const price = TIER_PRICES[this.selectedTier];
    const priceStr = currency === 'INR'
      ? `\u20b9${price.INR.toLocaleString('en-IN')}`
      : `$${price.USD}`;
    const otherCurrency = currency === 'INR' ? 'USD' : 'INR';
    const otherLabel    = currency === 'INR' ? 'Pay in USD' : 'Pay in INR';

    el.innerHTML = `
      <div class="gl" style="margin-bottom:6px">Step 5 \u2014 Payment</div>
      <h3 class="booking-title">Review & Pay</h3>
      <p class="booking-desc">Appointment confirmed instantly after payment</p>

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

      <div style="margin-top:16px;padding:14px 16px;background:rgba(200,169,81,.07);border:1px solid rgba(200,169,81,.2);display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div>
          <div style="font-family:'Tenor Sans',sans-serif;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold);margin-bottom:4px">Amount Due</div>
          <div style="font-family:'Cormorant',serif;font-size:28px;font-weight:300;color:var(--white)" id="price-display">${priceStr}</div>
        </div>
        <button id="currency-switch" style="font-size:10px;color:var(--muted);background:none;border:1px solid var(--line);padding:6px 12px;cursor:pointer;letter-spacing:.1em;text-transform:uppercase">
          ${otherLabel}
        </button>
      </div>

      <div style="font-size:11px;color:var(--faint);margin-top:10px;line-height:1.7">
        ${window.__PAYMENT_TEST_MODE__
          ? '\u26a1 Test mode \u2014 no real payment charged \u00b7 Appointment will be booked'
          : currency === 'INR'
            ? '\ud83d\udd12 Secure payment via Razorpay \u00b7 UPI, Cards, NetBanking accepted'
            : '\ud83d\udd12 Secure payment via Stripe \u00b7 All major cards, Apple Pay, Google Pay'}
      </div>

      <div class="booking-nav" style="margin-top:20px">
        <button class="btn-o booking-back" id="step-back"><span>&larr; Back</span></button>
        <button class="btn-g booking-confirm" id="pay-btn">
          <span>${window.__PAYMENT_TEST_MODE__ ? 'Confirm Booking (Test)' : `Pay ${priceStr} &amp; Confirm`}</span>
        </button>
      </div>`;

    document.getElementById('step-back').addEventListener('click', () => { this.step = 3; this.render(); });

    document.getElementById('currency-switch').addEventListener('click', () => {
      this._currency = otherCurrency;
      this.renderConfirm();
    });

    document.getElementById('pay-btn').addEventListener('click', () => this.startPayment());
  }

  // \u2500\u2500 Load Razorpay SDK lazily \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  _loadRazorpay() {
    return new Promise((resolve, reject) => {
      if (window.Razorpay) return resolve();
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload  = resolve;
      s.onerror = () => reject(new Error('Failed to load Razorpay'));
      document.head.appendChild(s);
    });
  }

  // \u2500\u2500 Main payment dispatcher \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  async startPayment() {
    const btn  = document.getElementById('pay-btn');
    const span = btn.querySelector('span');
    btn.disabled = true;
    btn.style.opacity = '0.7';
    span.textContent = 'Preparing payment\u2026';

    const bookingPayload = {
      tier:            this.selectedTier,
      date:            this.selectedDate,
      time_start:      this.selectedSlot.start,
      time_end:        this.selectedSlot.end,
      health_concerns: this.healthData.health_concerns,
      medical_history: this.healthData.medical_history || '',
      goals:           this.healthData.goals || '',
    };

    try {
      // Test mode: skip real gateways, book directly
      if (window.__PAYMENT_TEST_MODE__) {
        await this._payTest(bookingPayload, btn, span);
      } else if (this._currency === 'INR') {
        await this._payRazorpay(bookingPayload, btn, span);
      } else {
        await this._payStripe(bookingPayload, btn, span);
      }
    } catch (e) {
      if (typeof Toast !== 'undefined') Toast.error(e.message || 'Payment failed. Please try again.');
      btn.disabled = false;
      btn.style.opacity = '';
      span.textContent = 'Pay & Confirm';
    }
  }

  async _payTest(payload, btn, span) {
    span.textContent = 'Processing…';
    const r = await fetch('/api/payments/test/complete', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, currency: this._currency }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Test payment failed');
    this._showPaymentSuccess(data.appointment);
  }

  async _payRazorpay(payload, btn, span) {
    // 1. Create Razorpay order
    const r = await fetch('/api/payments/razorpay/create-order', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const order = await r.json();
    if (!r.ok) throw new Error(order.error || 'Could not create payment order');

    // 2. Load SDK
    await this._loadRazorpay();

    // 3. Open Razorpay popup
    return new Promise((resolve, reject) => {
      const rzp = new window.Razorpay({
        key:         order.key_id,
        amount:      order.amount,
        currency:    'INR',
        order_id:    order.order_id,
        name:        'theanirudhcode',
        description: order.tier_label,
        image:       '/favicon.svg',
        prefill: {
          name:  Auth.user.name,
          email: Auth.user.email,
          contact: Auth.user.phone || '',
        },
        theme: { color: '#c8a951' },
        modal: {
          ondismiss: () => {
            btn.disabled = false;
            btn.style.opacity = '';
            span.textContent = 'Pay & Confirm';
            resolve(); // user closed \u2014 don't reject
          }
        },
        handler: async (response) => {
          span.textContent = 'Verifying payment\u2026';
          try {
            const vr = await fetch('/api/payments/razorpay/verify', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...payload, ...response }),
            });
            const vd = await vr.json();
            if (vr.ok) {
              this._showPaymentSuccess(vd.appointment);
            } else {
              throw new Error(vd.error || 'Payment verification failed');
            }
          } catch (e) {
            reject(e);
          }
          resolve();
        },
      });
      rzp.open();
    });
  }

  async _payStripe(payload, btn, span) {
    span.textContent = 'Redirecting to Stripe\u2026';
    const r = await fetch('/api/payments/stripe/create-session', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not start Stripe checkout');
    // Stripe keys not yet set \u2014 server booked directly
    if (data.test_mode) {
      this._showPaymentSuccess(data.appointment);
      return;
    }
    window.location.href = data.url;
  }

  _showPaymentSuccess(appt) {
    const tier = CONSULTATION_TIERS[this.selectedTier];
    if (typeof Toast !== 'undefined') Toast.success('Payment confirmed! Appointment booked.');
    this.container.innerHTML = `
      <div style="text-align:center;padding:40px 0">
        <div style="font-size:52px;margin-bottom:16px;color:var(--gold)">&#10003;</div>
        <h3 style="font-family:'Cormorant',serif;font-size:clamp(24px,3vw,36px);font-weight:300;margin-bottom:12px">
          Paid &amp; <em style="color:var(--gold2)">Confirmed</em>
        </h3>
        <p style="color:var(--muted);font-size:var(--fb);margin-bottom:8px;font-weight:200">${tier.label}</p>
        <p style="color:var(--faint);font-size:13px;margin-bottom:24px;line-height:1.7">
          A confirmation has been sent to your WhatsApp and email.<br>
          Dr. Anirudh will be in touch 24 hours before your session.
        </p>
        <div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap">
          <a href="/my-appointments" class="btn-g" style="text-decoration:none;display:inline-flex;padding:14px 32px"><span>View My Appointments</span></a>
          <button class="btn-o" onclick="bookingModal.close()"><span>Close</span></button>
        </div>
      </div>`;
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
