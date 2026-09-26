// Per-field render/coerce/validate/secret contract for the generic settings renderer.
// This task fixes the CONTRACT (including the field-handle return shape) and renders a
// real, deliberately plain native control for every one of the five SettingDefinition
// types. Plan 02 restyles boolean/multiselect behind this same handle; plan 03 fills in
// dirty state, commit/revert and masking. Those are functionality gaps, not
// architectural ones — the namespace, signatures and handle shape are final here.
//
// CRITICAL, load-bearing for the phase threat model: every control's live value is set
// by assigning `.value`/`.checked` as a DOM property. A stored value is never
// interpolated into an HTML string — these are user-supplied, attacker-influenceable
// strings (an API key, a pasted RPC URL), unlike the computed numbers cic.ts interpolates
// freely.

(() => {
  let uidCounter = 0;

  function nextUid(prefix) {
    uidCounter += 1;
    return `${prefix}-${uidCounter}`;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Static, developer-authored glyph markup — never a stored/user-supplied value — built via
  // createElementNS rather than innerHTML to stay consistent with this file's DOM-property-only
  // rule for anything that touches the DOM (see the file-head comment).
  function makeIcon(kind) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    function shape(tag, attrs) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const k in attrs) el.setAttribute(k, String(attrs[k]));
      svg.appendChild(el);
    }
    if (kind === 'commit') {
      shape('polyline', { points: '20 6 9 17 4 12' });
    } else if (kind === 'revert') {
      shape('polyline', { points: '1 4 1 10 7 10' });
      shape('path', { d: 'M3.51 15a9 9 0 1 0 2.13-9.36L1 10' });
    } else if (kind === 'reveal') {
      shape('path', { d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' });
      shape('circle', { cx: '12', cy: '12', r: '3' });
    } else if (kind === 'reveal-off') {
      shape('path', {
        d: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24',
      });
      shape('line', { x1: '1', y1: '1', x2: '23', y2: '23' });
    }
    return svg;
  }

  function coerceForCommit(def, rawValue) {
    if (def.type === 'multiselect') return rawValue;
    if (def.type === 'number') return Number(rawValue);
    if (def.type === 'select' && typeof def.default === 'number') return Number(rawValue);
    return rawValue;
  }

  // Emptiness for `required` is per-type: '' for text, [] for multiselect, null/undefined
  // for anything programmatic. Testing only `''` lets a required multiselect commit empty.
  function isEmptyForRequired(value) {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value === '';
    if (Array.isArray(value)) return value.length === 0;
    return false;
  }

  function validate(def, value) {
    const validation = def?.validation;
    if (!validation) return { ok: true };

    const label = def?.label || 'This field';

    if (validation.required && isEmptyForRequired(value)) {
      return { ok: false, message: `${label} is required.` };
    }

    // Run the numeric check whenever the field is number-typed OR declares a bound at all —
    // NaN < min and NaN > max both evaluate false, so without this a non-finite value would
    // otherwise *pass* an inclusive-bounds check and persist as JSON `null` (review A4).
    const isNumeric = (def && def.type === 'number') || validation.min != null || validation.max != null;
    if (isNumeric) {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        return { ok: false, message: `${label} must be a valid number.` };
      }
      if (validation.min != null && num < validation.min) {
        return { ok: false, message: `${label} must be at least ${validation.min}.` };
      }
      if (validation.max != null && num > validation.max) {
        return { ok: false, message: `${label} must be no more than ${validation.max}.` };
      }
    }

    if (validation.pattern) {
      let regex: RegExp;
      try {
        regex = new RegExp(validation.pattern);
      } catch {
        return { ok: false, message: `${label}'s validation pattern is not usable.` };
      }
      if (!regex.test(String(value))) {
        return { ok: false, message: `${label} does not match the required format.` };
      }
    }

    return { ok: true };
  }

  // Per D-06/D-07: credential-like fields are identified by an explicit local registry, not a
  // key-name heuristic (rejected — false positives on legitimate names like `publicKey`) or a
  // marker on the definition object (rejected — DxKit's SettingDefinition has no such field).
  // This is a knowing, documented dent in "no per-dapp code": the generic renderer now names one
  // section by id. DX-01 (tmp/dxkit-fr-secret-flag.md) asks upstream for a `secret?: boolean` on
  // SettingDefinition, which would remove the need for this registry entirely.
  const SECRET_FIELDS = { ethereum: ['etherscanApiKey'] };

  function isSecret(sectionId, key) {
    return Boolean(SECRET_FIELDS[sectionId]?.includes(key));
  }

  // SINGLETON ASSUMPTION: this file has exactly one consumer — the settings dapp's generic
  // renderer in settings.ts — and this set is shared module state across everything that one
  // consumer renders. Reveal is a "is this key currently shown" flag scoped to the whole mounted
  // dapp, not to an individual field handle. If a second consumer of fields.ts ever exists,
  // revealed state would leak between them; move this into per-instance scope if that happens.
  // Deliberate simplification for one caller, not an oversight.
  const revealedKeys = new Set<string>();

  function resetRevealState() {
    revealedKeys.clear();
  }

  function buildLabel(def, textId?: string) {
    const label = document.createElement('label');
    const text = document.createElement('span');
    if (textId) text.id = textId;
    text.textContent = def.label;
    label.appendChild(text);
    if (def.description) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = def.description;
      label.appendChild(hint);
    }
    return label;
  }

  function renderField(def, value, ctx) {
    const labelTextId = nextUid('field-label');
    const element = document.createElement('div');
    element.className = 'input-group';
    // Booleans build their own name/switch row instead of the shared label — everything
    // else keeps the current label-then-control layout verbatim.
    if (def.type !== 'boolean') {
      element.appendChild(buildLabel(def, labelTextId));
    }

    let control: any;
    let checkboxes: any[] = [];
    // Boolean uses a single role=switch button rather than a control element — tracked
    // separately so getRawValue/setValue/setDisabled can branch on it.
    let boolValue = false;
    let switchBtn: any;
    const listeners = [];

    function on(target, type, handler) {
      target.addEventListener(type, handler);
      listeners.push(() => target.removeEventListener(type, handler));
    }

    let errorEl: any = null;

    function clearFieldError() {
      if (errorEl?.parentNode) errorEl.parentNode.removeChild(errorEl);
      errorEl = null;
      const wrap = element.querySelector('.input-wrap');
      if (wrap) wrap.classList.remove('has-error');
    }

    function showFieldError(message) {
      clearFieldError();
      errorEl = document.createElement('div');
      errorEl.className = 'settings-field-error';
      errorEl.textContent = message;
      element.appendChild(errorEl);
      const wrap = element.querySelector('.input-wrap');
      if (wrap) wrap.classList.add('has-error');
    }

    // Real per-field dirty state (D-16). Only text/number ever set this true — the other three
    // types commit live per D-12 and never carry a control strip, so they stay clean forever.
    let dirty = false;
    let inputWrapEl: any = null;
    let commitBtnEl: any = null;
    // WR-02: text/number's commit/revert/reveal strip, tracked so setDisabled can toggle
    // `disabled` on every button alongside the input — the input alone going disabled left the
    // strip fully operable.
    const stripButtons: any[] = [];
    // WR-02: mirrors setDisabled's flag independent of the DOM `disabled` attribute, so a click
    // handler is inert even in an environment that does not suppress activation on a disabled
    // button (see setDisabled below).
    let fieldDisabled = false;
    // WR-04: the value last known to agree with the store — the boolean/select/multiselect
    // branches paint their new value before validating (a button click or native `change` event
    // has already mutated the DOM), so a rejected commit needs something to roll the control back
    // to. Seeded from the initial store value; kept current by every successful commit and every
    // external repaint via setValue.
    let lastCommitted = value;

    function setDirty(flag) {
      dirty = flag;
      if (inputWrapEl) inputWrapEl.classList.toggle('is-dirty', flag);
      if (commitBtnEl) commitBtnEl.classList.toggle('is-active', flag);
    }

    function attemptCommit(rawValue) {
      const semantic = coerceForCommit(def, rawValue);
      const result = validate(def, semantic);
      if (!result.ok) {
        showFieldError(result.message);
        return false;
      }
      clearFieldError();
      ctx.commit(semantic);
      setDirty(false);
      lastCommitted = semantic;
      return true;
    }

    function commitFromControl() {
      if (fieldDisabled) return;
      const committed = attemptCommit(getRawValue());
      // WR-04: this is what makes `dirty === false` honest for the three live-commit types —
      // after a rollback the control and the store agree again, which is the property the sync
      // path's own-commit guard reads through getSemanticValue(). Text/number are untouched:
      // they already hold the user's edit and carry a real dirty flag instead.
      if (!committed && (def.type === 'boolean' || def.type === 'select' || def.type === 'multiselect')) {
        setValue(lastCommitted);
      }
    }

    // D-11: revert restores def.default and commits it unconditionally — available whether or
    // not the field is currently dirty. For etherscanApiKey (default '') this doubles as
    // clear-the-credential, which is exactly why it is not gated on dirty state.
    function doRevert() {
      if (fieldDisabled) return;
      setValue(def.default);
      clearFieldError();
      ctx.commit(coerceForCommit(def, getRawValue()));
      setDirty(false);
    }

    function getRawValue() {
      switch (def.type) {
        case 'boolean':
          return boolValue;
        case 'multiselect':
          return checkboxes.filter((cb) => cb.checked).map((cb) => cb.value);
        default:
          return control.value;
      }
    }

    // State lives in exactly one place: the aria-checked attribute. The CSS keys off it
    // directly, so there is no separate class to fall out of sync.
    function syncSwitch() {
      switchBtn.setAttribute('aria-checked', String(boolValue));
    }

    if (def.type === 'text' || def.type === 'number') {
      // Per D-10/D-12: text and number commit per field via an explicit control, never live on
      // change. The tracer's blur-save `change` handler (plan 01) is gone — replaced here, not
      // merely deleted, by the commit/revert strip below.
      const secret = def.type === 'text' && isSecret(ctx.sectionId, def.key);
      const revealKey = `${ctx.sectionId}\0${def.key}`;
      const startRevealed = revealedKeys.has(revealKey);

      control = document.createElement('input');
      control.type = def.type === 'number' ? 'number' : secret && !startRevealed ? 'password' : 'text';
      control.autocomplete = 'off';
      // D-06/T-1-PWMANAGER: a password-typed input in a form-looking page is exactly what a
      // password manager offers to save — and rpcUrl is not a credential either, so it gets the
      // same explicit opt-out even though it never renders type=password.
      if (secret || def.key === 'rpcUrl') {
        control.setAttribute('spellcheck', 'false');
        control.setAttribute('autocapitalize', 'off');
      }
      if (def.type === 'number') {
        if (def.validation?.min != null) control.min = String(def.validation.min);
        if (def.validation?.max != null) control.max = String(def.validation.max);
        control.value = String(value);
      } else {
        // The value reaches the DOM exactly once, here, as a property assignment — never
        // interpolated into markup (T-1-XSS). Masking a password-typed input is presentation
        // only; the value never has a second destination.
        control.value = value;
      }

      const inputWrap = document.createElement('div');
      inputWrap.className = secret ? 'input-wrap has-controls-3' : 'input-wrap has-controls-2';
      inputWrap.appendChild(control);

      const controls = document.createElement('div');
      controls.className = 'controls';

      let revealBtn: any = null;
      if (secret) {
        revealBtn = document.createElement('button');
        revealBtn.type = 'button';
        revealBtn.setAttribute('aria-label', startRevealed ? 'Hide value' : 'Reveal value');
        revealBtn.appendChild(makeIcon(startRevealed ? 'reveal-off' : 'reveal'));
        controls.appendChild(revealBtn);
      }

      const commitBtn = document.createElement('button');
      commitBtn.type = 'button';
      commitBtn.setAttribute('aria-label', 'Save value');
      commitBtn.appendChild(makeIcon('commit'));
      controls.appendChild(commitBtn);

      const revertBtn = document.createElement('button');
      revertBtn.type = 'button';
      revertBtn.setAttribute('aria-label', 'Revert to default');
      revertBtn.appendChild(makeIcon('revert'));
      controls.appendChild(revertBtn);

      inputWrap.appendChild(controls);
      element.appendChild(inputWrap);

      inputWrapEl = inputWrap;
      commitBtnEl = commitBtn;
      if (revealBtn) stripButtons.push(revealBtn);
      stripButtons.push(commitBtn, revertBtn);

      if (revealBtn) {
        on(revealBtn, 'click', () => {
          if (fieldDisabled) return;
          const revealing = control.type === 'password';
          control.type = revealing ? 'text' : 'password';
          if (revealing) revealedKeys.add(revealKey);
          else revealedKeys.delete(revealKey);
          revealBtn.setAttribute('aria-label', revealing ? 'Hide value' : 'Reveal value');
          while (revealBtn.firstChild) revealBtn.removeChild(revealBtn.firstChild);
          revealBtn.appendChild(makeIcon(revealing ? 'reveal-off' : 'reveal'));
        });
      }

      on(control, 'input', () => {
        setDirty(true);
        clearFieldError();
      });
      // D-15: Enter is a keyboard alias for the commit button — route both to the same function
      // rather than duplicating the commit logic.
      on(control, 'keydown', (e: any) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitFromControl();
        }
      });
      on(commitBtn, 'click', commitFromControl);
      on(revertBtn, 'click', doRevert);
    } else if (def.type === 'boolean') {
      boolValue = Boolean(value);

      // UI-05: a binary choice reads as a switch, not a stretched two-button radiogroup —
      // right-aligned on the name row, with its description (if any) as a following sibling.
      const row = document.createElement('div');
      row.className = 'settings-switch-row';

      const labelSpan = document.createElement('span');
      labelSpan.className = 'settings-switch-label';
      labelSpan.id = labelTextId;
      labelSpan.textContent = def.label;
      row.appendChild(labelSpan);

      switchBtn = document.createElement('button');
      switchBtn.type = 'button';
      switchBtn.className = 'switch';
      switchBtn.setAttribute('role', 'switch');
      switchBtn.setAttribute('aria-labelledby', labelTextId);

      const thumb = document.createElement('span');
      thumb.className = 'switch-thumb';
      switchBtn.appendChild(thumb);

      syncSwitch();

      // No keydown handler: a native <button> already fires `click` on Space (on keyup)
      // and Enter, so adding one here would double-fire against that native activation.
      on(switchBtn, 'click', () => {
        boolValue = !boolValue;
        syncSwitch();
        commitFromControl();
      });

      row.appendChild(switchBtn);
      element.appendChild(row);

      if (def.description) {
        const hint = document.createElement('div');
        hint.className = 'hint settings-switch-hint';
        hint.textContent = def.description;
        element.appendChild(hint);
      }
    } else if (def.type === 'select') {
      control = document.createElement('select');
      for (const opt of def.options || []) {
        const optionEl = document.createElement('option');
        optionEl.value = opt.value;
        optionEl.textContent = opt.label;
        control.appendChild(optionEl);
      }
      control.value = String(value);
      // UI-04: .select-wrap is only a positioned parent for the themed chevron — control
      // stays the <select> itself, so getRawValue/setValue/setDisabled below are unaffected.
      const selectWrap = document.createElement('div');
      selectWrap.className = 'select-wrap';
      selectWrap.appendChild(control);
      element.appendChild(selectWrap);
      on(control, 'change', commitFromControl);
    } else if (def.type === 'multiselect') {
      control = document.createElement('div');
      control.className = 'settings-checkbox-list';
      const selected = Array.isArray(value) ? value.map(String) : [];
      for (const opt of def.options || []) {
        const optLabel = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = opt.value;
        cb.checked = selected.includes(opt.value);
        optLabel.appendChild(cb);
        optLabel.appendChild(document.createTextNode(opt.label));
        control.appendChild(optLabel);
        checkboxes.push(cb);
        on(cb, 'change', commitFromControl);
      }
      element.appendChild(control);
    }

    function setValue(v) {
      if (def.type === 'boolean') {
        boolValue = Boolean(v);
        syncSwitch();
      } else if (def.type === 'multiselect') {
        const selected = Array.isArray(v) ? v.map(String) : [];
        for (const cb of checkboxes) cb.checked = selected.includes(cb.value);
      } else if (def.type === 'select') {
        control.value = String(v);
      } else if (def.type === 'number') {
        control.value = String(v);
      } else {
        control.value = v;
      }
      // WR-04: any external repaint (a same-tab commit elsewhere, a cross-tab sync) means the
      // store now holds `v` — keep the rollback target current so a later rejected commit rolls
      // back to what's actually stored, not a stale initial value.
      lastCommitted = v;
    }

    function setDisabled(flag) {
      fieldDisabled = Boolean(flag);
      if (def.type === 'multiselect') {
        for (const cb of checkboxes) cb.disabled = flag;
      } else if (def.type === 'boolean') {
        switchBtn.disabled = flag;
      } else {
        control.disabled = flag;
        // WR-02: the strip must go inert alongside the input — without this a disabled
        // text/number field could still be committed, reverted, or revealed.
        for (const btn of stripButtons) btn.disabled = flag;
      }
      element.classList.toggle('is-disabled', Boolean(flag));
    }

    function getSemanticValue() {
      return coerceForCommit(def, getRawValue());
    }

    function isDirty() {
      return dirty;
    }

    function destroy() {
      for (const off of listeners) off();
      listeners.length = 0;
      checkboxes = [];
    }

    // dependsOn names a boolean sibling in the same section. ctx.readSibling gives the
    // *initial* state only — settings.ts's refreshDependants is what keeps this live after
    // the sibling is committed (see settings.ts).
    if (def.dependsOn && typeof ctx.readSibling === 'function') {
      setDisabled(!ctx.readSibling(def.dependsOn));
    }

    return {
      element,
      sectionId: ctx.sectionId,
      key: def.key,
      def,
      setValue,
      setDisabled,
      getSemanticValue,
      isDirty,
      destroy,
    };
  }

  window.DnznSettingsFields = { renderField, coerceForCommit, validate, isSecret, resetRevealState };
})();
