(() => {
  const registry = /* @__PURE__ */ new Map();
  function fieldKey(sectionId, key) {
    return `${sectionId}\0${key}`;
  }
  const SECTION_ORDER = ["ethereum"];
  function orderSections(sections) {
    const named = [];
    const remainder = [];
    let shellSection = null;
    for (const section of sections) {
      if (section.id === "_shell") {
        shellSection = section;
      } else if (SECTION_ORDER.includes(section.id)) {
        named.push(section);
      } else {
        remainder.push(section);
      }
    }
    named.sort((a, b) => SECTION_ORDER.indexOf(a.id) - SECTION_ORDER.indexOf(b.id));
    const ordered = named.concat(remainder);
    if (shellSection) ordered.push(shellSection);
    return ordered;
  }
  function getField(sectionId, key) {
    return registry.get(fieldKey(sectionId, key));
  }
  function isDirty(sectionId, key) {
    const handle = getField(sectionId, key);
    return handle ? handle.isDirty() : false;
  }
  function repaintField(sectionId, key, value) {
    const handle = getField(sectionId, key);
    if (!handle) return;
    handle.setValue(value);
  }
  function getSemanticValue(sectionId, key) {
    return getField(sectionId, key)?.getSemanticValue();
  }
  function refreshDependants(sectionId) {
    const dx = window.__DXKIT__;
    for (const handle of registry.values()) {
      if (handle.sectionId !== sectionId || !handle.def.dependsOn) continue;
      handle.setDisabled(!dx.settings.get(sectionId, handle.def.dependsOn));
    }
  }
  function buildPrivacyNotice() {
    const notice = document.createElement("div");
    notice.className = "settings-privacy-notice";
    const heading = document.createElement("div");
    heading.className = "settings-privacy-notice-heading";
    heading.textContent = "Privacy";
    notice.appendChild(heading);
    const paragraphs = [
      "Stored in plaintext in this browser under the localStorage key dnzn:dotdev:settings \u2014 any script on this origin and devtools can read it. Field masking is presentation only.",
      "No backend, so nothing reaches DNZN \u2014 but your credentials are sent to the providers you configure them for, Etherscan and your RPC.",
      "Connecting a wallet asks your wallet directly, on each load, which account it currently authorises for this origin \u2014 that answer is held in memory for as long as this page is open and is not stored anywhere. The wallet plugin separately records which provider you used under dnzn:dotdev:wallet, in plaintext \u2014 any script on this origin and devtools can read it \u2014 and this site deletes that key on every load. The address is supplied locally by your wallet, is not sent to DNZN or any backend, and leaves the page only when you take an explicit action such as Copy. Nothing in this milestone signs with it, and no key material is handled anywhere on this site."
    ];
    for (const text of paragraphs) {
      const p = document.createElement("p");
      p.textContent = text;
      notice.appendChild(p);
    }
    return notice;
  }
  function init(container) {
    const dx = window.__DXKIT__;
    const sections = orderSections(dx.settings.getSections());
    const root = container.querySelector("#settings-root") ?? container;
    root.appendChild(buildPrivacyNotice());
    for (const section of sections) {
      if (!section.definitions || section.definitions.length === 0) continue;
      const card = document.createElement("div");
      card.className = "card";
      const title = document.createElement("div");
      title.className = "card-title";
      title.textContent = section.label;
      card.appendChild(title);
      for (const def of section.definitions) {
        const value = dx.settings.get(section.id, def.key);
        const ctx = {
          sectionId: section.id,
          commit(v) {
            dx.settings.set(section.id, def.key, v);
            refreshDependants(section.id);
          },
          markDirty() {
          },
          readSibling(key) {
            return dx.settings.get(section.id, key);
          }
        };
        const handle = window.DnznSettingsFields.renderField(def, value, ctx);
        registry.set(fieldKey(section.id, def.key), handle);
        card.appendChild(handle.element);
      }
      root.appendChild(card);
    }
    const detach = window.DnznSettingsSync.attachExternalSync(dx, { isDirty, repaintField, getSemanticValue });
    return function cleanup() {
      for (const handle of registry.values()) {
        handle.destroy();
      }
      registry.clear();
      window.DnznSettingsFields.resetRevealState();
      detach();
      root.innerHTML = "";
    };
  }
  window.DnznSettingsDapp = { init, orderSections, getField, isDirty, repaintField, getSemanticValue };
})();
