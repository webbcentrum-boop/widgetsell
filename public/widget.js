(function (w, d) {
  'use strict';

  if (d.getElementById('cw-root')) return; // prevent double-init

  // ── Resolve base URL from script src ──────────────────────────────────────
  const scriptEl = d.currentScript || (function () {
    const scripts = d.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  }());
  const _cfg = w.WidgetSellConfig || {};
  const BASE = _cfg.baseUrl || scriptEl.src.replace(/\/[^/]+$/, '');
  const widgetConfig = {
    webhookUrl: _cfg.webhookUrl || null,
    bookingUrl: _cfg.bookingUrl || null,
    agentName:  _cfg.agentName  || null,
  };

  // ── Extract page theme ─────────────────────────────────────
  const pageTheme = (function () {
    try {
      const rootCSS = w.getComputedStyle(d.documentElement);
      const varNames = ['--primary','--primary-color','--accent','--accent-color',
                        '--brand','--brand-color','--color-primary','--theme-color',
                        '--main-color','--highlight','--link-color'];
      for (const v of varNames) {
        const val = rootCSS.getPropertyValue(v).trim();
        if (val && /^#|^rgb|^hsl/.test(val)) return { accent: val };
      }
      const btn = d.querySelector([
        'button[class*="primary"]','button[class*="cta"]','.btn-primary',
        '.button--primary','.button-primary','[class*="hero"] a[class*="btn"]'
      ].join(','));
      if (btn) {
        const bg = w.getComputedStyle(btn).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return { accent: bg };
      }
      const link = d.querySelector('nav a, header a');
      if (link) {
        const c = w.getComputedStyle(link).color;
        if (c && c !== 'rgb(0, 0, 0)' && c !== 'rgb(255, 255, 255)') return { accent: c };
      }
      const font = w.getComputedStyle(d.body).fontFamily;
      return { accent: null, font };
    } catch { return null; }
  }());

  // ── Scan host website ─────────────────────────────────────────────────────
  const pageScan = (function () {
    try {
      const clone = d.body.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,svg,iframe,nav,footer').forEach(el => el.remove());
      const bodyText = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
      return {
        title:       d.title,
        url:         w.location.href,
        description: d.querySelector('meta[name="description"]')?.content || '',
        h1s:         [...d.querySelectorAll('h1')].map(e => e.textContent.trim()).filter(Boolean).join(' | '),
        h2s:         [...d.querySelectorAll('h2,h3')].map(e => e.textContent.trim()).filter(Boolean).slice(0, 20).join(' | '),
        bodyText,
      };
    } catch { return null; }
  }());

  // ── Inject styles ──────────────────────────────────────────────────────────
  const css = d.createElement('style');
  css.textContent = `
    #cw-launcher {
      position: fixed;
      bottom: 24px;
      right: 24px;
      height: 50px;
      padding: 0 20px 0 16px;
      border-radius: 25px;
      background: var(--ws-accent-grad, linear-gradient(135deg, #10b981 0%, #059669 100%));
      box-shadow: var(--ws-accent-shadow, 0 4px 24px rgba(16,185,129,.5), 0 1px 6px rgba(0,0,0,.25), 0 0 0 1px rgba(16,185,129,.2));
      cursor: pointer;
      border: none;
      display: flex;
      align-items: center;
      gap: 9px;
      z-index: 2147483646;
      outline: none;
      animation: cw-appear .5s cubic-bezier(.34,1.56,.64,1) both;
      transition: transform .2s ease, box-shadow .25s ease;
      white-space: nowrap;
    }
    #cw-launcher:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 32px rgba(16,185,129,.65), 0 2px 8px rgba(0,0,0,.25);
    }
    #cw-launcher:active {
      transform: translateY(-1px);
    }
    #cw-launcher:focus-visible {
      outline: 2px solid #34d399;
      outline-offset: 3px;
    }
    @keyframes cw-appear {
      from { transform: translateY(16px) scale(.9); opacity: 0; }
      to   { transform: translateY(0)    scale(1);  opacity: 1; }
    }
    .cw-icon { display: flex; align-items: center; transition: transform .28s cubic-bezier(.34,1.56,.64,1), opacity .2s ease; }
    .cw-icon-chat  { opacity: 1;  transform: scale(1); }
    .cw-icon-close { opacity: 0;  transform: scale(0) rotate(45deg); position: absolute; }
    #cw-launcher.cw-open .cw-icon-chat  { opacity: 0;  transform: scale(0) rotate(-45deg); }
    #cw-launcher.cw-open .cw-icon-close { opacity: 1;  transform: scale(1) rotate(0deg); }
    .cw-label { font: 600 13.5px/1 -apple-system, system-ui, sans-serif; color: #fff; letter-spacing: .01em; transition: opacity .2s; }
    #cw-launcher.cw-open .cw-label { opacity: 0; pointer-events: none; }

    #cw-badge {
      position: absolute;
      top: -5px; right: -5px;
      min-width: 19px; height: 19px;
      border-radius: 10px;
      background: #e11d48;
      box-shadow: 0 0 0 2px #fff, 0 2px 8px rgba(225,29,72,.4);
      font: 700 10px/15px -apple-system, sans-serif;
      color: #fff;
      display: flex; align-items: center; justify-content: center;
      padding: 0 3px;
      opacity: 0;
      transform: scale(0);
      transition: transform .35s cubic-bezier(.34,1.56,.64,1), opacity .2s;
    }
    #cw-badge.cw-show {
      opacity: 1;
      transform: scale(1);
    }

    #cw-frame-wrap {
      position: fixed;
      bottom: 90px;
      right: 24px;
      width: 390px;
      height: 628px;
      border-radius: 22px;
      overflow: hidden;
      z-index: 2147483645;
      box-shadow:
        0 0 0 1px rgba(22,163,74,.12),
        0 8px 32px rgba(0,0,0,.12),
        0 32px 80px rgba(0,0,0,.15);
      transform-origin: bottom right;
      transition: transform .35s cubic-bezier(.34,1.56,.64,1), opacity .25s ease;
      transform: scale(.86) translateY(16px);
      opacity: 0;
      pointer-events: none;
    }
    #cw-frame-wrap.cw-open {
      transform: scale(1) translateY(0);
      opacity: 1;
      pointer-events: all;
    }
    #cw-frame-wrap iframe {
      width: 100%; height: 100%;
      border: none; display: block;
    }

    @media (max-width: 500px) {
      #cw-frame-wrap {
        bottom: 82px;
        right: 12px;
        left: 12px;
        width: auto;
        height: min(580px, calc(100dvh - 100px));
        border-radius: 20px;
      }
      #cw-launcher { bottom: 20px; right: 16px; }
    }
  `;
  d.head.appendChild(css);

  // ── Apply host brand color to launcher ────────────────────────────────────
  if (pageTheme?.accent) {
    try {
      const canvas = d.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = pageTheme.accent;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      if (r || g || b) {
        const root = d.documentElement.style;
        root.setProperty('--ws-accent-grad', `linear-gradient(135deg, rgb(${r},${g},${b}) 0%, rgb(${Math.max(0,r-30)},${Math.max(0,g-30)},${Math.max(0,b-30)}) 100%)`);
        root.setProperty('--ws-accent-shadow', `0 4px 24px rgba(${r},${g},${b},.45), 0 1px 6px rgba(0,0,0,.25), 0 0 0 1px rgba(${r},${g},${b},.2)`);
      }
    } catch {}
  }

  // ── Launcher button ────────────────────────────────────────────────────────
  const launcher = d.createElement('button');
  launcher.id = 'cw-launcher';
  launcher.setAttribute('aria-label', 'Open chat');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.innerHTML = `
    <span class="cw-icon cw-icon-chat" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M20 2H4C2.9 2 2 2.9 2 4v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
    </span>
    <span class="cw-icon cw-icon-close" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </span>
    <span class="cw-label">Chatta med oss</span>
    <span id="cw-badge" aria-hidden="true">1</span>
  `;
  d.body.appendChild(launcher);

  // ── Iframe wrapper ─────────────────────────────────────────────────────────
  const wrap = d.createElement('div');
  wrap.id = 'cw-frame-wrap';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-label', 'WidgetSell chat');

  const iframe = d.createElement('iframe');
  iframe.src = BASE + '/widget-frame';
  iframe.title = 'WidgetSell';
  iframe.setAttribute('allow', 'microphone');
  wrap.appendChild(iframe);
  d.body.appendChild(wrap);

  // Send site scan data to iframe once it has loaded
  iframe.addEventListener('load', function () {
    if (pageScan) {
      iframe.contentWindow.postMessage({ type: 'cw:sitedata', data: pageScan, config: widgetConfig, theme: pageTheme }, '*');
    }
  });

  // ── Badge: show after 1.5 s on first visit ─────────────────────────────────
  const badge = d.getElementById('cw-badge');
  let badgeDismissed = false;
  setTimeout(function () {
    if (!badgeDismissed) badge.classList.add('cw-show');
  }, 1500);

  // ── Open / close ───────────────────────────────────────────────────────────
  let isOpen = false;

  function open() {
    isOpen = true;
    launcher.classList.add('cw-open');
    wrap.classList.add('cw-open');
    launcher.setAttribute('aria-expanded', 'true');
    launcher.setAttribute('aria-label', 'Close chat');
    badgeDismissed = true;
    badge.classList.remove('cw-show');
    iframe.contentWindow && iframe.contentWindow.postMessage('cw:open', '*');
    if (pageScan && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'cw:sitedata', data: pageScan, config: widgetConfig, theme: pageTheme }, '*');
    }
  }

  function close() {
    isOpen = false;
    launcher.classList.remove('cw-open');
    wrap.classList.remove('cw-open');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-label', 'Open chat');
    iframe.contentWindow && iframe.contentWindow.postMessage('cw:stop', '*');
  }

  function toggle() { isOpen ? close() : open(); }

  launcher.addEventListener('click', toggle);

  // Close on Escape
  d.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) close();
  });

  // Listen for close/minimize from inside the iframe
  w.addEventListener('message', function (e) {
    if (e.data === 'cw:close') close();
  });

  // ── Public API ─────────────────────────────────────────────────────────────
  w.WidgetSell = { open: open, close: close, toggle: toggle };

}(window, document));
