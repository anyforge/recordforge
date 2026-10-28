// src/core/finder-script.js
//
// The page-side replay runtime. Like the capture script, it is stringified and
// injected into a frame, then driven through short `window.__rfReplay.<fn>(...)`
// expressions. It resolves finders deterministically and returns geometry so the
// host can dispatch real CDP input events.

export function replayRuntimeSource() {
  const fn = function installReplayRuntime() {
    if (window.__rfReplay) return true;

    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    function findByText(doc, t) {
      const target = String(t || '').trim();
      if (!target) return null;
      const interactive = 'a,button,[role=button],[role=link],[role=menuitem],[role=option],[role=tab],[role=treeitem],[role=menuitemcheckbox],[role=menuitemradio],[role=radio],[role=checkbox],[role=switch],label,summary,[onclick]';
      let best = null;
      const score = (el) => {
        const txt = norm(el.textContent);
        if (!txt) return -1;
        let s;
        if (txt === target) s = 1000;
        else if (txt.startsWith(target) || txt.endsWith(target)) s = 500;
        else if (txt.indexOf(target) >= 0) s = 200;
        else return -1;
        if (el.matches && el.matches(interactive)) s += 100;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return -1; // hidden
        s -= Math.min(txt.length, 200); // prefer the smallest (leaf) element
        return s;
      };
      const all = doc.querySelectorAll('*');
      for (const el of all) {
        const s = score(el);
        if (s < 0) continue;
        if (!best || s > best.s) best = { el, s };
      }
      return best ? best.el : null;
    }

    function findByLabel(doc, t) {
      const target = String(t || '').trim();
      if (!target) return null;
      const labels = doc.querySelectorAll('label');
      for (const l of labels) {
        const lt = norm(l.textContent);
        if (lt === target || lt.indexOf(target) === 0) {
          const forId = l.getAttribute('for');
          if (forId) { const el = doc.getElementById(forId); if (el) return el; }
          const control = l.querySelector('input,textarea,select');
          if (control) return control;
        }
      }
      return null;
    }

    function findByCol(doc, t) {
      const target = String(t || '').trim();
      if (!target) return null;
      const tables = doc.querySelectorAll('table');
      for (const table of tables) {
        const thead = table.querySelector('thead');
        if (!thead) continue;
        const rows = Array.prototype.slice.call(thead.querySelectorAll('tr'));
        const lastRow = rows[rows.length - 1];
        const cols = [];
        for (const cell of Array.prototype.slice.call(lastRow.children)) {
          const span = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10) || 1);
          for (let k = 0; k < span; k++) cols.push(norm(cell.textContent).slice(0, 20));
        }
        const idx = cols.findIndex((c) => c === target);
        if (idx < 0) continue;
        const tbody = table.querySelector('tbody') || table;
        const firstRow = tbody.querySelector('tr');
        if (!firstRow) continue;
        const cell = Array.prototype.slice.call(firstRow.children)[idx];
        if (cell) return cell;
      }
      return null;
    }

    function byXPath(doc, xp) {
      try {
        const res = doc.evaluate(xp, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return res.singleNodeValue || null;
      } catch (e) {
        return null;
      }
    }

    function resolveEl(finders) {
      for (const f of (finders || [])) {
        let el = null;
        switch (f.type) {
          case 'id': el = document.getElementById(f.value); break;
          case 'css': try { el = document.querySelector(f.value); } catch (e) {} break;
          case 'text': el = findByText(document, f.value); break;
          case 'label': el = findByLabel(document, f.value); break;
          case 'col': el = findByCol(document, f.value); break;
          case 'xpath': el = byXPath(document, f.value); break;
        }
        if (el) return el;
      }
      return null;
    }

    function describe(el) {
      const r = el.getBoundingClientRect();
      return {
        found: true,
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        value: el.value !== undefined ? String(el.value) : '',
        text: norm(el.textContent).slice(0, 80),
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        cx: r.x + r.width / 2,
        cy: r.y + r.height / 2,
        checked: !!el.checked,
        disabled: !!el.disabled,
        contentEditable: !!el.isContentEditable,
      };
    }

    function nativeSet(el, value) {
      const tag = el.tagName;
      let setter = null;
      try {
        if (tag === 'TEXTAREA') setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        else if (tag === 'INPUT') setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        else if (tag === 'SELECT') setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      } catch (e) {}
      if (setter) setter.call(el, value);
      else if (el.value !== undefined) el.value = value;
      else el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    window.__rfReplay = {
      resolve(finders) {
        const el = resolveEl(finders);
        if (!el) return { found: false };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        return describe(el);
      },
      setValue(finders, value) {
        const el = resolveEl(finders);
        if (!el) return { found: false };
        el.focus();
        nativeSet(el, value);
        return describe(el);
      },
      setSelect(finders, value) {
        const el = resolveEl(finders);
        if (!el) return { found: false };
        el.focus();
        try { el.value = value; } catch (e) {}
        nativeSet(el, value);
        return describe(el);
      },
      scrollBy(y) {
        window.scrollBy(0, y);
        return { found: true, scrollY: window.scrollY };
      },
      // Return the <input type=file> node's backend id path is not available
      // here; uploads are handled by the host via DOM.setFileInputFiles after
      // resolving the element through this same finder. This helper just proves
      // the element exists and returns its descriptor.
      resolveOnly(finders) {
        const el = resolveEl(finders);
        if (!el) return { found: false };
        return describe(el);
      },
      // JS click — fallback for cross-origin iframes where CDP coordinates
      // cannot be offset into the top frame.
      click(finders) {
        const el = resolveEl(finders);
        if (!el) return { found: false };
        el.click();
        return describe(el);
      },
      // JS hover — same fallback path as click.
      hover(finders) {
        const el = resolveEl(finders);
        if (!el) return { found: false };
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        return describe(el);
      },
      // Return the raw element (not by value) so the host can request its DOM
      // node for CDP file uploads.
      object(finders) {
        return resolveEl(finders);
      },
    };
    return true;
  };
  return `(${fn.toString()})()`;
}
