// src/core/capture-script.js
//
// The page-side recorder. This entire function is stringified and injected into
// a live page over CDP, so it must stay fully self-contained: no imports, no
// references to host scope, only browser globals. It must also be idempotent —
// a frame can be injected more than once (navigation, dynamic iframes).

// Build the injection source for the capture script. The recorder is a single
// self-contained function; every helper lives inside it so that the stringified
// form has no dangling references.
export function captureScriptSource() {
  const fn = function captureScript() {
    if (window.__recordforge) return true;
    window.__recordforge = { steps: [] };
    const rec = window.__recordforge.steps;

    // Field types whose value must never leave the page. The recorder stores a
    // `{SECRET:<name>}` placeholder instead of reading the value, so a password,
    // one-time code or card number never crosses the CDP boundary.
    const SENSITIVE_AUTOCOMPLETE = [
      'current-password',
      'new-password',
      'one-time-code',
      'cc-number',
      'cc-csc',
    ];

    const esc = (s) => {
      try { return CSS.escape(s); } catch (e) { return String(s).replace(/"/g, '\\"'); }
    };

    // Keep only stable, semantic class names and drop transient interaction
    // state classes (e.g. `ant-select-open`, `-active`, `-hover`) plus dynamic
    // hash classes. A selector that depends on a hover/focus state will not
    // match during replay, when that state is absent.
    function stableClassList(el) {
      if (!el || typeof el.className !== 'string') return [];
      const raw = el.className.trim();
      if (!raw) return [];
      const transient = /-(focused|focus|open|active|hover|selected|checked|visible|hidden)$/;
      return raw.split(/\s+/).filter((c) =>
        /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(c) &&
        !/\d{4,}/.test(c) &&
        !transient.test(c)
      );
    }

    // Structural CSS path: at most 6 levels deep, stops at an id, and prefers
    // stable classes over nth-of-type (which is brittle across DOM changes).
    function cssPath(el) {
      if (!el || el === document.body) return 'body';
      const parts = [];
      let n = el;
      while (n && n !== document.body && parts.length < 6) {
        let seg = n.tagName.toLowerCase();
        if (n.id) { seg += '#' + esc(n.id); parts.unshift(seg); break; }
        const cls = stableClassList(n);
        if (cls.length) seg += '.' + cls.join('.');
        else if (n.parentElement) {
          const same = Array.prototype.slice.call(n.parentElement.children).filter((c) => c.tagName === n.tagName);
          if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
        }
        parts.unshift(seg);
        n = n.parentElement;
      }
      return parts.join(' > ');
    }

    // Full XPath from the current document root (inside an iframe that is the
    // iframe's own <html>, not the top page's). Each level carries an index,
    // which makes it precise for elements with no id or text.
    function fullXPath(el) {
      if (!el || el.nodeType !== 1) return '';
      const parts = [];
      let n = el;
      while (n && n.nodeType === 1) {
        let idx = 1;
        let sib = n.previousElementSibling;
        while (sib) { if (sib.tagName === n.tagName) idx++; sib = sib.previousElementSibling; }
        parts.unshift(n.tagName.toLowerCase() + '[' + idx + ']');
        if (n === document.documentElement) break;
        n = n.parentElement;
      }
      return '/' + parts.join('/');
    }

    function isSensitive(el) {
      if (!el) return false;
      if (el.type === 'password') return true;
      const ac = String((el.getAttribute && el.getAttribute('autocomplete')) || '').toLowerCase();
      return SENSITIVE_AUTOCOMPLETE.indexOf(ac) >= 0;
    }

    function secretName(el) {
      const n = (el.name || el.id || (el.getAttribute && el.getAttribute('placeholder')) || '').trim();
      return n.slice(0, 40) || 'secret';
    }

    // Multi-strategy locator. Priority: stable id -> stable class -> name ->
    // data-testid -> placeholder -> aria-label -> title -> form-item container
    // title -> visible text -> associated label -> table column header ->
    // structural cssPath. `alt` carries fallback locators the replay engine
    // tries in order when the primary one fails.
    function locator(el) {
      const out = { selector: '', text: '' };
      if (!el) return { selector: 'body', text: '' };

      if (el.id) {
        // Hash-prefixed ids (e.g. `56dd4bb8...-editor-field-name`) vary per
        // session; the suffix is the stable field id. Use it only when unique.
        const hm = el.id.match(/^([0-9a-f]{20,32})-(.+)$/);
        if (hm && hm[2] && hm[2].length >= 4) {
          const sel = '[id$="' + hm[2].replace(/"/g, '\\"') + '"]';
          try { if (document.querySelectorAll(sel).length === 1) out.selector = sel; } catch (e) {}
        } else {
          let uniq;
          try { uniq = document.querySelectorAll('#' + esc(el.id)).length === 1; } catch (e) { uniq = false; }
          if (uniq) out.selector = '#' + esc(el.id);
        }
      }

      if (!out.selector) {
        const cls = stableClassList(el);
        if (cls.length) {
          const sel = el.tagName.toLowerCase() + '.' + cls.join('.');
          try { if (document.querySelectorAll(sel).length === 1) out.selector = sel; } catch (e) {}
        }
      }
      if (!out.selector && el.name) out.selector = '[name="' + String(el.name).replace(/"/g, '\\"') + '"]';
      const dt = el.getAttribute ? (el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-test-id')) : '';
      if (!out.selector && dt) out.selector = '[data-testid="' + String(dt).replace(/"/g, '\\"') + '"]';
      const ph = el.getAttribute ? String(el.getAttribute('placeholder') || '').trim() : '';
      if (!out.selector && ph) out.selector = '[placeholder="' + ph.replace(/"/g, '\\"') + '"]';
      const al = el.getAttribute ? String(el.getAttribute('aria-label') || '').trim() : '';
      if (!out.selector && al) out.selector = '[aria-label="' + al.replace(/"/g, '\\"') + '"]';
      const ti = el.getAttribute ? String(el.getAttribute('title') || '').trim() : '';
      if (!out.selector && ti) out.selector = '[title="' + ti.replace(/"/g, '\\"') + '"]';

      // Form field inside a titled form-item container (e.g. div[title="Amount"]).
      // The container title is stable where a hash id is not.
      if (!out.selector && el.tagName && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
        try {
          let anc = el.parentElement, depth = 0;
          while (anc && anc !== document.body && depth < 6) {
            const at = (anc.getAttribute ? String(anc.getAttribute('title') || '').trim() : '') || '';
            if (at && at.length <= 30 && anc.querySelectorAll) {
              const sel = anc.tagName.toLowerCase() + '[title="' + at.replace(/"/g, '\\"') + '"] ' + el.tagName.toLowerCase();
              try { if (document.querySelectorAll(sel).length === 1) { out.selector = sel; break; } } catch (e) {}
            }
            anc = anc.parentElement; depth++;
          }
        } catch (e) {}
      }

      const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (t) out.text = t;
      if (!out.selector && t && t.length <= 30) {
        // Visible text beats a structural path for replay robustness.
        out.selector = 'text:' + t;
      }

      // A clicked container (e.g. a <td>) that holds exactly one placeholder
      // input — use that input (Ant Design date pickers).
      if (!out.selector) {
        try {
          if (el.querySelectorAll) {
            const ins = el.querySelectorAll('input[placeholder],textarea[placeholder]');
            if (ins.length === 1) {
              const iph = String(ins[0].getAttribute('placeholder') || '').trim();
              if (iph) out.selector = '[placeholder="' + iph.replace(/"/g, '\\"') + '"]';
            }
          }
        } catch (e) {}
      }

      // Form field: associated <label> text (label[for], ancestor label, or the
      // nearest label inside an ancestor container).
      if (!out.selector && el.tagName && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
        try {
          let labelEl = null;
          if (el.id) labelEl = document.querySelector('label[for="' + esc(el.id) + '"]');
          if (!labelEl && el.closest) labelEl = el.closest('label');
          if (!labelEl) {
            let anc = el.parentElement, depth = 0;
            while (anc && anc !== document.body && depth < 6 && !labelEl) {
              const l = anc.querySelector && anc.querySelector('label');
              if (l && (l.textContent || '').trim()) labelEl = l;
              anc = anc.parentElement; depth++;
            }
          }
          if (labelEl) {
            const lt = (labelEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20);
            if (lt) out.selector = 'label:' + lt;
          }
        } catch (e) {}
      }

      // Table cell (or a field inside one): use its column header text.
      if (!out.selector) {
        const tag2 = el.tagName;
        const td = (tag2 === 'TD' || tag2 === 'TH') ? el : (el.closest ? el.closest('td,th') : null);
        if (td) {
          try {
            const table = td.closest('table');
            const row = td.closest('tr');
            if (table && row) {
              const colIdx = Array.prototype.indexOf.call(row.children, td);
              if (colIdx >= 0) {
                let ht = '';
                const thead = table.querySelector('thead');
                if (thead) {
                  const theadRows = Array.prototype.slice.call(thead.querySelectorAll('tr'));
                  const lastRow = theadRows[theadRows.length - 1];
                  const cols = [];
                  for (const cell of Array.prototype.slice.call(lastRow.children)) {
                    const span = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10) || 1);
                    const txt = (cell.textContent || '').replace(/\s+/g, ' ').trim();
                    for (let k = 0; k < span; k++) cols.push(txt);
                  }
                  if (cols[colIdx]) ht = cols[colIdx].slice(0, 20);
                }
                if (!ht) {
                  const ths = table.querySelectorAll('thead th, thead td');
                  ht = ths[colIdx] ? (ths[colIdx].textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20) : '';
                }
                if (ht) out.selector = 'col:' + ht;
              }
            }
          } catch (e) {}
        }
      }

      if (!out.selector) out.selector = cssPath(el);

      // Fallback locators, tried in order by the replay engine.
      out.alt = [];
      const cp = cssPath(el);
      if (cp && cp !== out.selector) out.alt.push(cp);
      if (out.text && out.selector && out.selector.indexOf('text:') !== 0) out.alt.push('text:' + out.text);
      const xp = fullXPath(el);
      if (xp && xp !== out.selector && xp !== cp) out.alt.push('xpath:' + xp);
      return out;
    }

    const isForm = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.isContentEditable);

    // Deliver a step. Local buffer for idempotency/debug; the host binding is
    // the real delivery channel, so a click that navigates the page never loses
    // its step (the in-page buffer is wiped on navigation).
    const push = (type, data) => {
      const step = Object.assign({ action: type, url: location.href, ts: Date.now() }, data);
      rec.push(step);
      try {
        if (window.__recordforgePush) window.__recordforgePush(JSON.stringify([step]));
      } catch (e) {}
    };

    let activeInput = null;        // { el, loc, last, dirty }
    let lastClick = { selector: '', ts: 0 };
    let lastScrollY = -1;
    let hoverTimer = null;
    let hoverEl = null;
    let lastHover = { selector: '', ts: 0 };

    // Record the FINAL value of a form field (on blur/submit/Enter), not every
    // keystroke. Sensitive fields are never read — a placeholder is emitted.
    function flushInput(el) {
      if (!activeInput || activeInput.el !== el) return;
      const cur = activeInput;
      activeInput = null;
      // SELECT is captured as a 'select' step, checkbox/radio as 'click', and
      // file inputs as 'upload' by their own handlers. Only text-like inputs
      // and textareas produce a 'type' step here.
      if (el.tagName === 'SELECT') return;
      if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio' || el.type === 'file')) return;
      const sensitive = isSensitive(el);
      let value;
      if (sensitive) {
        if (!cur.dirty) return; // focused but never typed — nothing to record
        value = '{SECRET:' + secretName(el) + '}';
      } else {
        const v = (el.value !== undefined) ? el.value : (el.textContent || '');
        if (!cur.dirty && v === cur.last) return; // unchanged — skip empty blur
        value = String(v).slice(0, 500);
      }
      push('type', { tag: el.tagName.toLowerCase(), loc: locator(el), value, sensitive: !!sensitive });
    }

    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t) return;
      const chk = t.closest && t.closest('input');
      if (chk && (chk.type === 'checkbox' || chk.type === 'radio')) {
        push('click', { tag: 'input', inputType: chk.type, loc: locator(chk), value: chk.checked ? 'checked' : 'unchecked' });
        return;
      }
      if (t.closest && t.closest('input,textarea,select')) {
        const el = t.closest('input,textarea,select');
        if (isForm(el) && !(el.type === 'checkbox' || el.type === 'radio') && !activeInput) {
          activeInput = { el, loc: locator(el), last: (el.value !== undefined ? el.value : (el.textContent || '')), dirty: false };
        }
        return;
      }
      const SEL = 'a,button,[role=button],[role=link],[role=menuitem],[role=option],[role=tab],[role=treeitem],[role=menuitemcheckbox],[role=menuitemradio],[role=gridcell],[role=combobox],[role=radio],[role=checkbox],[role=switch],label,summary,[onclick],[contenteditable="true"]';
      let clickable;
      if (t.closest) {
        clickable = t.closest(SEL) || t.closest('li,td');
        if (!clickable && t !== document.body && t !== document.documentElement) clickable = t;
      } else {
        clickable = t;
      }
      if (!clickable) return;
      const loc = locator(clickable);
      const now = Date.now();
      if (lastClick.selector === loc.selector && now - lastClick.ts < 400) return; // double-click dedupe
      lastClick = { selector: loc.selector, ts: now };
      push('click', { tag: clickable.tagName.toLowerCase(), loc });
    }, true);

    document.addEventListener('focusin', (e) => {
      if (isForm(e.target)) {
        activeInput = {
          el: e.target,
          loc: locator(e.target),
          last: (e.target.value !== undefined ? e.target.value : (e.target.textContent || '')),
          dirty: false,
        };
      }
    }, true);
    document.addEventListener('input', (e) => { if (activeInput && activeInput.el === e.target) activeInput.dirty = true; }, true);
    document.addEventListener('blur', (e) => { if (isForm(e.target)) flushInput(e.target); }, true);

    document.addEventListener('change', (e) => {
      const el = e.target;
      if (!el) return;
      if (el.tagName === 'SELECT') { push('select', { loc: locator(el), value: el.value }); return; }
      if (el.tagName === 'INPUT' && el.type === 'file') {
        const files = Array.prototype.slice.call(el.files || []).map((f) => f.name).join(', ');
        push('upload', { loc: locator(el), value: files });
      }
    }, true);

    document.addEventListener('contextmenu', (e) => {
      const t = e.target;
      if (!t) return;
      push('contextmenu', { loc: locator(t) });
    }, true);

    document.addEventListener('submit', (e) => {
      if (activeInput) flushInput(activeInput.el);
      push('submit', { loc: locator(e.target) });
    }, true);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && isForm(e.target) && !e.isComposing) {
        if (activeInput) flushInput(activeInput.el);
        push('submit', { via: 'enter', loc: locator(e.target) });
      }
    }, true);

    // Hover that pauses >=300ms on an interactive element opens menus/dropdowns.
    document.addEventListener('mouseover', (e) => {
      const hoverable = e.target && e.target.closest ? e.target.closest('a,button,[role=button],[role=link],[role=menuitem],summary,[onclick]') : null;
      if (!hoverable) return;
      hoverEl = hoverable;
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        const loc = locator(hoverEl);
        const now = Date.now();
        if (lastHover.selector === loc.selector && now - lastHover.ts < 1500) return;
        lastHover = { selector: loc.selector, ts: now };
        push('hover', { tag: hoverEl.tagName.toLowerCase(), loc });
      }, 300);
    }, true);
    document.addEventListener('mouseout', (e) => {
      if (hoverTimer && e.target === hoverEl) { clearTimeout(hoverTimer); hoverTimer = null; }
    }, true);

    let scrollTimer = null;
    document.addEventListener('scroll', () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        const y = Math.round(window.scrollY);
        if (Math.abs(y - lastScrollY) < 50) return;
        lastScrollY = y;
        push('scroll', { scrollY: y });
      }, 800);
    }, true);

    return true;
  };
  return `(${fn.toString()})()`;
}
