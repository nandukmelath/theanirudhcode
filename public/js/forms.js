document.addEventListener('DOMContentLoaded', () => {

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function setLoading(btn, loading) {
    const span = btn.querySelector('span');
    if (loading) {
      btn.disabled = true;
      btn.dataset.originalText = span.textContent;
      span.textContent = 'Sending...';
      btn.style.opacity = '0.7';
    } else {
      btn.disabled = false;
      span.textContent = btn.dataset.originalText || span.textContent;
      btn.style.opacity = '';
    }
  }

  function shakeInput(input) {
    input.style.borderColor = 'var(--amber)';
    input.classList.add('shake');
    setTimeout(() => {
      input.style.borderColor = '';
      input.classList.remove('shake');
    }, 600);
  }

  // ═══════════ FREE GUIDE FORM ═══════════
  const guideForm = document.getElementById('guide-form');
  if (guideForm) {
    guideForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = guideForm.querySelector('.fsubmit');
      const nameInput = guideForm.querySelector('[name="name"]');
      const emailInput = guideForm.querySelector('[name="email"]');

      if (!nameInput.value.trim()) { shakeInput(nameInput); Toast.error('Please enter your name'); return; }
      if (!isValidEmail(emailInput.value)) { shakeInput(emailInput); Toast.error('Please enter a valid email'); return; }

      setLoading(btn, true);
      try {
        const res = await fetch('/api/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nameInput.value.trim(), email: emailInput.value.trim(), source: 'free-guide' })
        });
        const data = await res.json();
        if (res.ok) {
          Toast.success(data.message);
          guideForm.reset();
          const span = btn.querySelector('span');
          span.textContent = 'Guide Sent! Check Email \u2713';
          btn.style.background = 'var(--gold2)';
          setTimeout(() => { span.textContent = 'Send Me the Guide \u2192'; btn.style.background = ''; }, 3000);
        } else {
          if (data.alreadySubscribed) Toast.info('You are already on the list! Check your email.');
          else Toast.error(data.error);
        }
      } catch (err) {
        Toast.error('Connection error. Please try again.');
      } finally {
        setLoading(btn, false);
      }
    });
  }

  // ═══════════ BOOKING MODAL ═══════════
  const modal = document.getElementById('consultation-modal');
  const closeBtn = document.getElementById('modal-close');

  function closeModal() {
    if (window.bookingModal) window.bookingModal.close();
    else { modal.classList.remove('open'); document.body.style.overflow = ''; }
  }

  // All elements with data-action="open-consultation" open the booking modal
  document.querySelectorAll('[data-action="open-consultation"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.bookingModal) window.bookingModal.open();
    });
  });

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (modal) {
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) closeModal();
  });

  // ═══════════ LIVE EMAIL VALIDATION ═══════════
  document.querySelectorAll('.finput[type="email"]').forEach(input => {
    input.addEventListener('input', () => {
      if (input.value) {
        input.style.borderColor = isValidEmail(input.value) ? 'rgba(200,169,81,.5)' : 'var(--amber)';
      } else {
        input.style.borderColor = '';
      }
    });
    input.addEventListener('blur', () => { input.style.borderColor = ''; });
  });

  // ═══════════ SCROLL BUTTONS ═══════════
  document.querySelectorAll('[data-scroll]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.querySelector(btn.dataset.scroll);
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    });
  });
});
