class Toast {
  static container = null;

  static _esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  static init() {
    if (this.container && document.body.contains(this.container)) return;
    let el = document.getElementById('toast-container');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast-container';
      // Inline fallback styles — work even when page CSS lacks #toast-container rules.
      el.style.cssText = 'position:fixed;bottom:24px;right:24px;left:auto;z-index:9998;display:flex;flex-direction:column;gap:10px;pointer-events:none;max-width:calc(100vw - 32px)';
      document.body.appendChild(el);
      Toast._injectFallbackStyles();
    }
    this.container = el;
  }

  static _injectFallbackStyles() {
    if (document.getElementById('_toast-fallback-css')) return;
    const s = document.createElement('style');
    s.id = '_toast-fallback-css';
    s.textContent = `
      .toast{pointer-events:auto;background:#0e0e0e;border:1px solid rgba(208,175,82,.22);padding:14px 20px;display:flex;align-items:center;gap:12px;font-family:'Barlow',sans-serif;font-size:14px;font-weight:300;color:#f9f5ee;min-width:260px;max-width:420px;opacity:0;transform:translateX(40px);transition:all .35s cubic-bezier(.22,1,.36,1)}
      .toast-in{opacity:1;transform:translateX(0)}
      .toast-out{opacity:0;transform:translateX(40px)}
      .toast-success{border-color:rgba(208,175,82,.45)}
      .toast-error{border-color:rgba(212,121,62,.55)}
      .toast-info{border-color:rgba(208,175,82,.25)}
      .toast-icon{font-size:14px;flex-shrink:0}
      .toast-success .toast-icon{color:#d0af52}
      .toast-error .toast-icon{color:#d4793e}
      .toast-info .toast-icon{color:#f8edbe}
      @media(max-width:540px){#toast-container{left:16px;right:16px;bottom:16px}.toast{min-width:auto;max-width:100%}}
    `;
    document.head.appendChild(s);
  }

  static show(message, type = 'success', duration = 4000) {
    this.init();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: '◆', error: '✖', info: '◇' };
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = icons[type] || icons.info;
    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = String(message == null ? '' : message);
    toast.appendChild(icon);
    toast.appendChild(msg);
    this.container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-in'));
    setTimeout(() => {
      toast.classList.remove('toast-in');
      toast.classList.add('toast-out');
      const onEnd = () => toast.remove();
      toast.addEventListener('transitionend', onEnd, { once: true });
      // Safety: ensure removal even if transitionend never fires (e.g. element detached)
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 1200);
    }, duration);
  }

  static success(msg) { this.show(msg, 'success'); }
  static error(msg)   { this.show(msg, 'error'); }
  static info(msg)    { this.show(msg, 'info'); }
}
