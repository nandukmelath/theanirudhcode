/* ═══════════════════════════════════════
   MULTI-STEP BOOKING MODAL
   4-step flow: Date → Time → Details → Confirm
═══════════════════════════════════════ */

class BookingModal {
  constructor() {
    this.step = 0;
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
    // Close booking modal and open auth modal instead
    this.close();
    if (window.openAuthModal) window.openAuthModal();
  }

  render() {
    const steps = ['Select Date', 'Choose Time', 'Health Details', 'Confirm'];
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
    if (this.step === 0) this.renderDateStep(content);
    else if (this.step === 1) this.renderTimeStep(content);
    else if (this.step === 2) this.renderHealthStep(content);
    else if (this.step === 3) this.renderConfirmStep(content);
  }

  async renderDateStep(el) {
    el.innerHTML = `
      <div class="gl" style="margin-bottom:6px">Step 1</div>
      <h3 class="booking-title">Select a Date</h3>
      <p class="booking-desc">Choose your preferred consultation date</p>
      <div id="calendar-loader" style="text-align:center;padding:40px 0;color:var(--muted)">Loading calendar...</div>
      <div id="calendar-grid" style="display:none"></div>`;

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

      // Empty cells for days before month start
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

      // Event listeners
      cells.querySelectorAll('.cal-cell.available, .cal-cell.selected').forEach(cell => {
        cell.addEventListener('click', () => {
          this.selectedDate = cell.dataset.date;
          this.selectedSlot = null;
          this.step = 1;
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
    const dateObj = new Date(this.selectedDate + 'T00:00:00');
    const dateLabel = dateObj.toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    el.innerHTML = `
      <div class="gl" style="margin-bottom:6px">Step 2</div>
      <h3 class="booking-title">Choose a Time Slot</h3>
      <p class="booking-desc">${dateLabel}</p>
      <div id="slots-loader" style="text-align:center;padding:40px 0;color:var(--muted)">Loading available slots...</div>
      <div id="slots-grid" class="booking-slots" style="display:none"></div>
      <div class="booking-nav">
        <button class="btn-o booking-back" id="step-back"><span>&larr; Back</span></button>
      </div>`;

    document.getElementById('step-back').addEventListener('click', () => { this.step = 0; this.render(); });

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
          this.step = 2;
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
    const dateObj = new Date(this.selectedDate + 'T00:00:00');
    const dateLabel = dateObj.toLocaleDateString('en', { month: 'short', day: 'numeric' });
    const startH = parseInt(this.selectedSlot.start.split(':')[0]);
    const ampm = startH >= 12 ? 'PM' : 'AM';
    const displayH = startH > 12 ? startH - 12 : startH;
    const timeLabel = `${displayH}:${this.selectedSlot.start.split(':')[1]} ${ampm}`;

    el.innerHTML = `
      <div class="gl" style="margin-bottom:6px">Step 3</div>
      <h3 class="booking-title">Your Health Details</h3>
      <p class="booking-desc">${dateLabel} at ${timeLabel}</p>
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

    document.getElementById('step-back').addEventListener('click', () => { this.step = 1; this.render(); });

    document.getElementById('health-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      this.healthData = Object.fromEntries(fd);
      if (!this.healthData.health_concerns || !this.healthData.health_concerns.trim()) {
        if (typeof Toast !== 'undefined') Toast.error('Please describe your health concerns');
        return;
      }
      this.step = 3;
      this.render();
    });
  }

  renderConfirmStep(el) {
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
      <div class="gl" style="margin-bottom:6px">Step 4</div>
      <h3 class="booking-title">Confirm Your Appointment</h3>
      <p class="booking-desc">Please review your details before confirming</p>

      <div class="confirm-card">
        <div class="confirm-row">
          <span class="confirm-label">Patient</span>
          <span class="confirm-value">${Auth.user.name}</span>
        </div>
        <div class="confirm-row">
          <span class="confirm-label">Email</span>
          <span class="confirm-value">${Auth.user.email}</span>
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

      <div class="booking-nav">
        <button class="btn-o booking-back" id="step-back"><span>&larr; Back</span></button>
        <button class="btn-g booking-confirm" id="confirm-btn"><span>Confirm Booking &check;</span></button>
      </div>`;

    document.getElementById('step-back').addEventListener('click', () => { this.step = 2; this.render(); });
    document.getElementById('confirm-btn').addEventListener('click', () => this.submitBooking());
  }

  async submitBooking() {
    const btn = document.getElementById('confirm-btn');
    const span = btn.querySelector('span');
    btn.disabled = true;
    span.textContent = 'Booking...';
    btn.style.opacity = '0.7';

    try {
      const res = await fetch('/api/appointments/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: this.selectedDate,
          time_start: this.selectedSlot.start,
          time_end: this.selectedSlot.end,
          health_concerns: this.healthData.health_concerns,
          medical_history: this.healthData.medical_history || '',
          goals: this.healthData.goals || ''
        })
      });
      const data = await res.json();

      if (res.ok) {
        if (typeof Toast !== 'undefined') Toast.success('Appointment booked successfully! Check your email for confirmation.');
        this.container.innerHTML = `
          <div style="text-align:center;padding:40px 0">
            <div style="font-size:48px;margin-bottom:16px;color:var(--gold)">&#10003;</div>
            <h3 style="font-family:'Cormorant',serif;font-size:clamp(24px,3vw,36px);font-weight:300;margin-bottom:12px">
              Appointment <em style="color:var(--gold2)">Confirmed</em>
            </h3>
            <p style="color:var(--muted);font-size:var(--fb);margin-bottom:24px;font-weight:200">
              Your consultation has been booked. You'll receive a calendar invite shortly.
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
});
