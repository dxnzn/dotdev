(() => {
  let uidCounter = 0;
  function nextUid(prefix) {
    uidCounter += 1;
    return `${prefix}-${uidCounter}`;
  }
  const SVG_NS = "http://www.w3.org/2000/svg";
  function makeIcon(kind) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    function shape(tag, attrs) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const k in attrs) el.setAttribute(k, String(attrs[k]));
      svg.appendChild(el);
    }
    if (kind === "commit") {
      shape("polyline", { points: "20 6 9 17 4 12" });
    } else if (kind === "revert") {
      shape("polyline", { points: "1 4 1 10 7 10" });
      shape("path", { d: "M3.51 15a9 9 0 1 0 2.13-9.36L1 10" });
    } else if (kind === "reveal") {
      shape("path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" });
      shape("circle", { cx: "12", cy: "12", r: "3" });
    } else if (kind === "reveal-off") {
      shape("path", {
        d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
      });
      shape("line", { x1: "1", y1: "1", x2: "23", y2: "23" });
    }
    return svg;
  }
  function coerceForCommit(def, rawValue) {
    if (def.type === "multiselect") return rawValue;
    if (def.type === "number") return Number(rawValue);
    if (def.type === "select" && typeof def.default === "number") return Number(rawValue);
    return rawValue;
  }
  function isEmptyForRequired(value) {
    if (value === void 0 || value === null) return true;
    if (typeof value === "string") return value === "";
    if (Array.isArray(value)) return value.length === 0;
    return false;
  }
  function validate(def, value) {
    const validation = def?.validation;
    if (!validation) return { ok: true };
    const label = def?.label || "This field";
    if (validation.required && isEmptyForRequired(value)) {
      return { ok: false, message: `${label} is required.` };
    }
    const isNumeric = def && def.type === "number" || validation.min != null || validation.max != null;
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
      let regex;
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
  const SECRET_FIELDS = { ethereum: ["etherscanApiKey"] };
  function isSecret(sectionId, key) {
    return Boolean(SECRET_FIELDS[sectionId]?.includes(key));
  }
  const revealedKeys = /* @__PURE__ */ new Set();
  function resetRevealState() {
    revealedKeys.clear();
  }
  function buildLabel(def, textId) {
    const label = document.createElement("label");
    const text = document.createElement("span");
    if (textId) text.id = textId;
    text.textContent = def.label;
    label.appendChild(text);
    if (def.description) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = def.description;
      label.appendChild(hint);
    }
    return label;
  }
  function renderField(def, value, ctx) {
    const labelTextId = nextUid("field-label");
    const element = document.createElement("div");
    element.className = "input-group";
    if (def.type !== "boolean") {
      element.appendChild(buildLabel(def, labelTextId));
    }
    let control;
    let checkboxes = [];
    let boolValue = false;
    let switchBtn;
    const listeners = [];
    function on(target, type, handler) {
      target.addEventListener(type, handler);
      listeners.push(() => target.removeEventListener(type, handler));
    }
    let errorEl = null;
    function clearFieldError() {
      if (errorEl?.parentNode) errorEl.parentNode.removeChild(errorEl);
      errorEl = null;
      const wrap = element.querySelector(".input-wrap");
      if (wrap) wrap.classList.remove("has-error");
    }
    function showFieldError(message) {
      clearFieldError();
      errorEl = document.createElement("div");
      errorEl.className = "settings-field-error";
      errorEl.textContent = message;
      element.appendChild(errorEl);
      const wrap = element.querySelector(".input-wrap");
      if (wrap) wrap.classList.add("has-error");
    }
    let dirty = false;
    let inputWrapEl = null;
    let commitBtnEl = null;
    const stripButtons = [];
    let fieldDisabled = false;
    let lastCommitted = value;
    function setDirty(flag) {
      dirty = flag;
      if (inputWrapEl) inputWrapEl.classList.toggle("is-dirty", flag);
      if (commitBtnEl) commitBtnEl.classList.toggle("is-active", flag);
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
      if (!committed && (def.type === "boolean" || def.type === "select" || def.type === "multiselect")) {
        setValue(lastCommitted);
      }
    }
    function doRevert() {
      if (fieldDisabled) return;
      setValue(def.default);
      clearFieldError();
      ctx.commit(coerceForCommit(def, getRawValue()));
      setDirty(false);
    }
    function getRawValue() {
      switch (def.type) {
        case "boolean":
          return boolValue;
        case "multiselect":
          return checkboxes.filter((cb) => cb.checked).map((cb) => cb.value);
        default:
          return control.value;
      }
    }
    function syncSwitch() {
      switchBtn.setAttribute("aria-checked", String(boolValue));
    }
    if (def.type === "text" || def.type === "number") {
      const secret = def.type === "text" && isSecret(ctx.sectionId, def.key);
      const revealKey = `${ctx.sectionId}\0${def.key}`;
      const startRevealed = revealedKeys.has(revealKey);
      control = document.createElement("input");
      control.type = def.type === "number" ? "number" : secret && !startRevealed ? "password" : "text";
      control.autocomplete = "off";
      if (secret || def.key === "rpcUrl") {
        control.setAttribute("spellcheck", "false");
        control.setAttribute("autocapitalize", "off");
      }
      if (def.type === "number") {
        if (def.validation?.min != null) control.min = String(def.validation.min);
        if (def.validation?.max != null) control.max = String(def.validation.max);
        control.value = String(value);
      } else {
        control.value = value;
      }
      const inputWrap = document.createElement("div");
      inputWrap.className = secret ? "input-wrap has-controls-3" : "input-wrap has-controls-2";
      inputWrap.appendChild(control);
      const controls = document.createElement("div");
      controls.className = "controls";
      let revealBtn = null;
      if (secret) {
        revealBtn = document.createElement("button");
        revealBtn.type = "button";
        revealBtn.setAttribute("aria-label", startRevealed ? "Hide value" : "Reveal value");
        revealBtn.appendChild(makeIcon(startRevealed ? "reveal-off" : "reveal"));
        controls.appendChild(revealBtn);
      }
      const commitBtn = document.createElement("button");
      commitBtn.type = "button";
      commitBtn.setAttribute("aria-label", "Save value");
      commitBtn.appendChild(makeIcon("commit"));
      controls.appendChild(commitBtn);
      const revertBtn = document.createElement("button");
      revertBtn.type = "button";
      revertBtn.setAttribute("aria-label", "Revert to default");
      revertBtn.appendChild(makeIcon("revert"));
      controls.appendChild(revertBtn);
      inputWrap.appendChild(controls);
      element.appendChild(inputWrap);
      inputWrapEl = inputWrap;
      commitBtnEl = commitBtn;
      if (revealBtn) stripButtons.push(revealBtn);
      stripButtons.push(commitBtn, revertBtn);
      if (revealBtn) {
        on(revealBtn, "click", () => {
          if (fieldDisabled) return;
          const revealing = control.type === "password";
          control.type = revealing ? "text" : "password";
          if (revealing) revealedKeys.add(revealKey);
          else revealedKeys.delete(revealKey);
          revealBtn.setAttribute("aria-label", revealing ? "Hide value" : "Reveal value");
          while (revealBtn.firstChild) revealBtn.removeChild(revealBtn.firstChild);
          revealBtn.appendChild(makeIcon(revealing ? "reveal-off" : "reveal"));
        });
      }
      on(control, "input", () => {
        setDirty(true);
        clearFieldError();
      });
      on(control, "keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitFromControl();
        }
      });
      on(commitBtn, "click", commitFromControl);
      on(revertBtn, "click", doRevert);
    } else if (def.type === "boolean") {
      boolValue = Boolean(value);
      const row = document.createElement("div");
      row.className = "settings-switch-row";
      const labelSpan = document.createElement("span");
      labelSpan.className = "settings-switch-label";
      labelSpan.id = labelTextId;
      labelSpan.textContent = def.label;
      row.appendChild(labelSpan);
      switchBtn = document.createElement("button");
      switchBtn.type = "button";
      switchBtn.className = "switch";
      switchBtn.setAttribute("role", "switch");
      switchBtn.setAttribute("aria-labelledby", labelTextId);
      const thumb = document.createElement("span");
      thumb.className = "switch-thumb";
      switchBtn.appendChild(thumb);
      syncSwitch();
      on(switchBtn, "click", () => {
        boolValue = !boolValue;
        syncSwitch();
        commitFromControl();
      });
      row.appendChild(switchBtn);
      element.appendChild(row);
      if (def.description) {
        const hint = document.createElement("div");
        hint.className = "hint settings-switch-hint";
        hint.textContent = def.description;
        element.appendChild(hint);
      }
    } else if (def.type === "select") {
      control = document.createElement("select");
      for (const opt of def.options || []) {
        const optionEl = document.createElement("option");
        optionEl.value = opt.value;
        optionEl.textContent = opt.label;
        control.appendChild(optionEl);
      }
      control.value = String(value);
      const selectWrap = document.createElement("div");
      selectWrap.className = "select-wrap";
      selectWrap.appendChild(control);
      element.appendChild(selectWrap);
      on(control, "change", commitFromControl);
    } else if (def.type === "multiselect") {
      control = document.createElement("div");
      control.className = "settings-checkbox-list";
      const selected = Array.isArray(value) ? value.map(String) : [];
      for (const opt of def.options || []) {
        const optLabel = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = opt.value;
        cb.checked = selected.includes(opt.value);
        optLabel.appendChild(cb);
        optLabel.appendChild(document.createTextNode(opt.label));
        control.appendChild(optLabel);
        checkboxes.push(cb);
        on(cb, "change", commitFromControl);
      }
      element.appendChild(control);
    }
    function setValue(v) {
      if (def.type === "boolean") {
        boolValue = Boolean(v);
        syncSwitch();
      } else if (def.type === "multiselect") {
        const selected = Array.isArray(v) ? v.map(String) : [];
        for (const cb of checkboxes) cb.checked = selected.includes(cb.value);
      } else if (def.type === "select") {
        control.value = String(v);
      } else if (def.type === "number") {
        control.value = String(v);
      } else {
        control.value = v;
      }
      lastCommitted = v;
    }
    function setDisabled(flag) {
      fieldDisabled = Boolean(flag);
      if (def.type === "multiselect") {
        for (const cb of checkboxes) cb.disabled = flag;
      } else if (def.type === "boolean") {
        switchBtn.disabled = flag;
      } else {
        control.disabled = flag;
        for (const btn of stripButtons) btn.disabled = flag;
      }
      element.classList.toggle("is-disabled", Boolean(flag));
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
    if (def.dependsOn && typeof ctx.readSibling === "function") {
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
      destroy
    };
  }
  window.DnznSettingsFields = { renderField, coerceForCommit, validate, isSecret, resetRevealState };
})();
