/* Premium "wow" interactions — magnetic buttons, 3D tilt, scroll reveals, stat counters */
(function () {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isFinePointer = window.matchMedia('(pointer: fine)').matches;

  // ── Scroll reveal (IntersectionObserver) ──────────────────────────────────
  const revealEls = document.querySelectorAll('.rv');
  if ('IntersectionObserver' in window && !reduceMotion) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e, i) => {
        if (e.isIntersecting) {
          // small stagger when siblings reveal together
          const delay = Math.min(i * 70, 350);
          setTimeout(() => e.target.classList.add('in'), delay);
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealEls.forEach(el => io.observe(el));
  } else {
    revealEls.forEach(el => el.classList.add('in'));
  }

  // ── Magnetic CTA buttons (desktop only, fine pointer) ──────────────────────
  if (isFinePointer && !reduceMotion) {
    const magnets = document.querySelectorAll('.btn-g, .float-cta, .pdf-dl-btn, .cohort-enroll-btn');
    magnets.forEach(btn => {
      const strength = 12; // px max offset
      btn.addEventListener('mousemove', (e) => {
        const r = btn.getBoundingClientRect();
        const x = (e.clientX - r.left - r.width / 2) / r.width;
        const y = (e.clientY - r.top - r.height / 2) / r.height;
        btn.style.transform = `translate(${x * strength}px, ${y * strength}px)`;
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.transform = '';
      });
    });

    // ── 3D card tilt ────────────────────────────────────────────────────────
    const tiltCards = document.querySelectorAll('.cp-card, .ins-card, .truth-card, .tcard');
    tiltCards.forEach(card => {
      const max = 6; // degrees
      card.addEventListener('mousemove', (e) => {
        const r = card.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width;
        const y = (e.clientY - r.top) / r.height;
        const rx = (0.5 - y) * max;
        const ry = (x - 0.5) * max;
        card.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-6px)`;
      });
      card.addEventListener('mouseleave', () => {
        card.style.transform = '';
      });
    });
  }

  // ── Animated stat counters (data-counter="12000") ──────────────────────────
  const counters = document.querySelectorAll('[data-counter]');
  if (counters.length && 'IntersectionObserver' in window && !reduceMotion) {
    const animateCount = (el, target) => {
      const duration = 1600;
      const start = performance.now();
      const step = (t) => {
        const elapsed = t - start;
        const p = Math.min(elapsed / duration, 1);
        // easeOutCubic
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased).toLocaleString();
        if (p < 1) requestAnimationFrame(step);
        else el.textContent = target.toLocaleString();
      };
      requestAnimationFrame(step);
    };
    const cio = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          const target = parseInt(e.target.getAttribute('data-counter'), 10);
          if (Number.isFinite(target)) animateCount(e.target, target);
          cio.unobserve(e.target);
        }
      });
    }, { threshold: 0.4 });
    counters.forEach(el => cio.observe(el));
  }
})();
