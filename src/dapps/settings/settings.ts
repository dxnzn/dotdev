// Generic section renderer — walks dx.settings.getSections() with no per-dapp code
// and appends one .card per section, one renderField call per definition, all DOM
// queries scoped to the mount container (never document). Also holds the field
// registry: the other half of the field-handle contract fixed in fields.ts, and the
// seam plans 03 and 05 consume verbatim via getField/isDirty/repaintField.

(() => {
  const registry = new Map();

  function fieldKey(sectionId, key) {
    return `${sectionId}\0${key}`;
  }

  // D-21: named sections render first, in this order. Everything else (a future dapp's
  // own manifest settings, a plugin section this phase doesn't know about) renders next,
  // keeping the relative order getSections() returned it in — so a new dapp needs no
  // change here. `_shell` is pinned last below regardless of where it arrived, since the
  // dapp-toggle list is the least important thing on this page.
  const SECTION_ORDER = ['ethereum'];

  function orderSections(sections) {
    const named = [];
    const remainder = [];
    let shellSection = null;
    for (const section of sections) {
      if (section.id === '_shell') {
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

  // 01-05: one-line delegation to the field handle's own coerced value — the seam
  // attachExternalSync's own-commit guard compares against, never the raw DOM string.
  function getSemanticValue(sectionId, key) {
    return getField(sectionId, key)?.getSemanticValue();
  }

  // A2/A3: ctx.readSibling only gives a dependant field its *initial* disabled state at
  // render time. DxKit's dependsOn is metadata only — nothing re-renders or refreshes a
  // dependant after its sibling commits. This walks the section's already-rendered handles
  // and flips setDisabled on each dependant in place, called from the commit path below so
  // committing the sibling true re-enables the dependant's existing control, not a rebuild.
  function refreshDependants(sectionId) {
    const dx = window.__DXKIT__;
    for (const handle of registry.values()) {
      if (handle.sectionId !== sectionId || !handle.def.dependsOn) continue;
      handle.setDisabled(!dx.settings.get(sectionId, handle.def.dependsOn));
    }
  }

  // D-31/SET-08: this notice carries the whole disclosure once, at the top of the page —
  // there is no per-field inline plaintext hint. Built as DOM nodes with no interpolated
  // value of any kind (it never touches a stored setting), so it cannot leak one by
  // construction. Concise by design (01-04 UAT gap: audience is technical) — three
  // paragraphs, not a restatement of what a technical reader already knows.
  //
  // The third paragraph changed shape at 02-09: there is no cache left to disclose. The site
  // asks the wallet directly, on every load, which account it currently authorises for this
  // origin, and holds the answer in memory only — nothing about it is written to storage. The
  // wallet plugin's own provider-id key survives (it is the plugin's, not this site's, and this
  // site deletes it on every load), so it still gets named alongside the address it no longer
  // stores.
  function buildPrivacyNotice() {
    const notice = document.createElement('div');
    notice.className = 'settings-privacy-notice';

    const heading = document.createElement('div');
    heading.className = 'settings-privacy-notice-heading';
    heading.textContent = 'Privacy';
    notice.appendChild(heading);

    const paragraphs = [
      'Stored in plaintext in this browser under the localStorage key dnzn:dotdev:settings — ' +
        'any script on this origin and devtools can read it. Field masking is presentation only.',
      'No backend, so nothing reaches DNZN — but your credentials are sent to the providers ' +
        'you configure them for, Etherscan and your RPC.',
      'Connecting a wallet asks your wallet directly, on each load, which account it currently ' +
        'authorises for this origin — that answer is held in memory for as long as this page is ' +
        'open and is not stored anywhere. The wallet plugin separately records which provider ' +
        'you used under dnzn:dotdev:wallet, in plaintext — any script on this origin and ' +
        'devtools can read it — and this site deletes that key on every load. The address is ' +
        'supplied locally by your wallet, is not sent to DNZN or any backend, and leaves the ' +
        'page only when you take an explicit action such as Copy. Nothing in this milestone ' +
        'signs with it, and no key material is handled anywhere on this site.',
    ];
    for (const text of paragraphs) {
      const p = document.createElement('p');
      p.textContent = text;
      notice.appendChild(p);
    }

    return notice;
  }

  function init(container) {
    const dx = window.__DXKIT__;
    const sections = orderSections(dx.settings.getSections());

    // WR-01: DxKit sets container.innerHTML = template.html and then hands init() that
    // same outer node, so #settings-root arrives as a CHILD of `container`, not as
    // `container` itself — content must nest inside it for the template's
    // `.layout-content` wrapper, and the `gap: 2rem` column spacing it carries, to
    // apply at all. The `?? container` fallback stays load-bearing: this file's own test
    // suite (and any future embedder) calls init() directly with a bare node that has
    // no #settings-root child at all, and that path must keep working unchanged.
    const root = container.querySelector('#settings-root') ?? container;

    root.appendChild(buildPrivacyNotice());

    for (const section of sections) {
      // D-24: a section with no definitions to show renders no card at all. A section
      // whose fields are all dependsOn-disabled is NOT empty by this rule — it still has
      // definitions, just temporarily disabled ones — so it keeps rendering below.
      if (!section.definitions || section.definitions.length === 0) continue;

      const card = document.createElement('div');
      card.className = 'card';

      const title = document.createElement('div');
      title.className = 'card-title';
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
            // No-op in this task; plan 03 makes dirty tracking real.
          },
          readSibling(key) {
            return dx.settings.get(section.id, key);
          },
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
      // Empty the resolved content node, not the outer container — dapp.ts already
      // clears the outer container on unmount, and clearing it here too would also
      // remove the #settings-root wrapper itself when it's a real template mount.
      root.innerHTML = '';
    };
  }

  window.DnznSettingsDapp = { init, orderSections, getField, isDirty, repaintField, getSemanticValue };
})();
