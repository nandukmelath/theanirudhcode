document.addEventListener('DOMContentLoaded', () => {

  // ═══════════ ANIMATED STATS COUNTERS ═══════════
  const statObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const el = entry.target;
        const target = parseInt(el.dataset.target);
        if (!target) return;
        const sup = el.querySelector('sup');
        const supText = sup ? sup.textContent : '';
        animateCounter(el, target, supText);
        statObserver.unobserve(el);
      }
    });
  }, { threshold: 0.5 });

  document.querySelectorAll('.stn[data-target]').forEach(el => statObserver.observe(el));

  function animateCounter(el, target, suffix) {
    const duration = 2000;
    const start = performance.now();
    const sup = el.querySelector('sup');

    function tick(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(target * eased);
      if (sup) {
        el.childNodes[0].textContent = current;
      } else {
        el.textContent = current + suffix;
      }
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // ═══════════ SCROLL PROGRESS BAR ═══════════
  const progressBar = document.getElementById('scroll-progress');
  if (progressBar) {
    window.addEventListener('scroll', () => {
      const scrollTop = document.documentElement.scrollTop;
      const scrollHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      const progress = scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0;
      progressBar.style.width = progress + '%';
    });
  }

  // ═══════════ BACK TO TOP ═══════════
  const btt = document.getElementById('back-to-top');
  if (btt) {
    window.addEventListener('scroll', () => {
      btt.classList.toggle('visible', scrollY > 600);
    });
    btt.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ═══════════ SMOOTH SCROLL FOR ANCHOR LINKS ═══════════
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href');
      if (href === '#') return;
      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // ═══════════ FAQ ACCORDION ═══════════
  document.querySelectorAll('.faq-item .faq-q').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
      if (!isOpen) item.classList.add('open');
    });
  });

  // ═══════════ FLOATING CONSULTATION CTA ═══════════
  const floatCta = document.getElementById('float-cta');
  if (floatCta) {
    window.addEventListener('scroll', () => {
      floatCta.classList.toggle('visible', scrollY > 500);
    }, { passive: true });
    floatCta.addEventListener('click', () => {
      const trigger = document.querySelector('[data-action="open-consultation"]');
      if (trigger) trigger.click();
    });
  }

  // ═══════════ MAGNETIC CURSOR ON CTA BUTTONS ═══════════
  document.querySelectorAll('.btn-g, .btn-o, .ncta').forEach(btn => {
    btn.addEventListener('mousemove', (e) => {
      const rect = btn.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      btn.style.transform = `translate(${x * 0.15}px, ${y * 0.15}px)`;
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = '';
    });
  });


});
