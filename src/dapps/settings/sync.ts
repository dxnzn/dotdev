// External-change reconciliation surface: a pure diff algorithm (diffAndReplay) plus
// the listener factory that applies it (attachExternalSync, filled in by plan 05's
// second task). Kept in one file because they share one contract: diffAndReplay never
// writes, attachExternalSync is the only thing that calls dx.settings.set.

(() => {
  // A "record" (not a value) is any non-null, non-array object — the section-values
  // shape `{ [key]: value }`. JSON.parse alone lets `null`, an array, or a primitive
  // through as a "section"; walking Object.entries on any of those throws or produces
  // nonsense, and this function must never throw out of a storage listener.
  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  // Strict equality for primitives; length + element-wise strict equality for arrays
  // (the only array-valued setting is multiselect). Never JSON.stringify to compare —
  // key order in a serialized object is not a semantic difference and would produce
  // spurious replays for object-shaped values, and two structurally-equal arrays
  // constructed independently are never the same reference.
  function valuesEqual(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }
    return a === b;
  }

  // Pure: takes a snapshot of what should change, decides nothing about how to apply
  // it, and writes nothing. readCurrent/isDirty are caller-supplied closures so this
  // has no dependency on dx.settings, localStorage, or the DOM — see
  // test/settings-diff.test.ts.
  //
  // Two properties here are load-bearing (D-18/D-19) and must not be reordered:
  //   1. Equality is checked BEFORE the dirty flag is consulted. A dirty key whose
  //      incoming value already matches the current one produces no record at all —
  //      this is what makes the storage/settings-set exchange self-terminating; a
  //      write-then-diff order would create a two-tab loop neither tab escapes.
  //   2. A dirty key that DOES differ still yields a record (repaint: false), not no
  //      record. The store gets corrected either way; only the visible input is held
  //      back. Skipping the write entirely would leave dx.settings.get() stale for a
  //      dirty field forever, since the origin tab has no other way to learn the user
  //      later reverted or the sibling tab's value is now authoritative.
  function diffAndReplay(readCurrent, incoming, isDirty) {
    if (!isRecord(incoming)) return [];

    const records = [];
    for (const [sectionId, values] of Object.entries(incoming)) {
      if (!isRecord(values)) continue;
      for (const [key, value] of Object.entries(values)) {
        const current = readCurrent(sectionId, key);
        if (valuesEqual(current, value)) continue;
        records.push({ sectionId, key, value, repaint: !isDirty(sectionId, key) });
      }
    }
    return records;
  }

  // Kept in sync with src/main.ts's STORAGE_NS (`dnzn:dotdev`) by convention, exactly
  // like index.html's FOUC script does for the theme key — this file has no import
  // path to the const itself (no bundler at runtime).
  const SETTINGS_STORAGE_KEY = 'dnzn:dotdev:settings';

  // Attaches both reconciliation listeners and returns a detach function releasing
  // both. opts supplies isDirty/repaintField/getSemanticValue — all three already
  // exist on the field registry settings.ts owns (plans 01/03); this file invents no
  // new state-access mechanism (review finding A2).
  function attachExternalSync(dx, opts) {
    function readCurrent(sectionId, key) {
      return dx.settings.get(sectionId, key);
    }

    // WR-03: look up the declared definition for a replayed record, if any.
    // dx.settings.getSections is optional-called and defaults to an empty list — not every
    // dx stub in this suite (or future host) provides it, and that must not break a replay
    // that would otherwise be perfectly valid.
    function findDefinition(sectionId, key) {
      const sections = dx.settings.getSections?.() ?? [];
      for (const section of sections) {
        if (section.id !== sectionId) continue;
        for (const def of section.definitions || []) {
          if (def.key === key) return def;
        }
      }
      return undefined;
    }

    // WR-03/WR-05: the one place that turns an external snapshot into writes, shared by
    // both the cross-tab storage listener and the mount-time reconcile below — so the
    // validate() gate applies identically to both, not just to whichever path was fixed
    // first.
    function replay(incoming) {
      const records = diffAndReplay(readCurrent, incoming, opts.isDirty);
      for (const record of records) {
        const def = findDefinition(record.sectionId, record.key);
        // A record with no matching definition (a section this build doesn't know about —
        // a newer build's own settings, or a plugin not yet wired here) validates clean and
        // is written; dropping it would let this build silently clobber a newer build's
        // section on its own next commit. record.repaint is not consulted here — it is
        // listener two's real-time isDirty check that decides whether to repaint, not this
        // stored flag. The write always lands; D-19 only ever withholds the *paint*.
        if (def && !window.DnznSettingsFields.validate(def, record.value).ok) continue;
        dx.settings.set(record.sectionId, record.key, record.value);
      }
    }

    // Listener one (D-17): a write from ANOTHER tab. The browser's `storage` event
    // never fires in the tab that made the write, which is exactly why listener two
    // below exists for the same-tab case. This handler WRITES ONLY — it never calls
    // repaintField itself. dx.settings.set() synchronously emits
    // dx:plugin:settings:changed, and listener two is the sole repaint path; a
    // handler that repainted here too would run every clean external update down
    // both paths and double-paint it (review: Codex HIGH).
    function onStorage(e) {
      if (e.key !== SETTINGS_STORAGE_KEY || e.newValue == null) return;
      let incoming: unknown;
      try {
        incoming = JSON.parse(e.newValue);
      } catch {
        return;
      }
      replay(incoming);
    }

    // Listener two (D-20): same-tab external changes (a future shell UI, the theme
    // panel) are invisible to the `storage` event, and it is also — now — the only
    // thing that repaints, for both same-tab and cross-tab changes alike.
    function onSettingsChanged(detail) {
      const { dappId, key, value } = detail;
      if (opts.isDirty(dappId, key)) return;
      // Compare against the field's coerced semantic value, never the raw DOM
      // string — a numeric select's DOM value is `'1'` while the stored value is
      // `1`, and a strict comparison against the wrong representation would never
      // agree, silently defeating the own-commit guard (review finding A6). An
      // unknown field (no handle) reads as `undefined`, which reads as "does not
      // agree" and falls through to repaintField's own no-op for that case.
      if (valuesEqual(opts.getSemanticValue(dappId, key), value)) return;
      opts.repaintField(dappId, key, value);
    }

    window.addEventListener('storage', onStorage);
    const listener = dx.events.on('dx:plugin:settings:changed', onSettingsChanged);

    // WR-05: reconcile once against the CURRENT localStorage snapshot, but only AFTER both
    // listeners above are live. Ordering is load-bearing and deliberate: fields are painted
    // from dx.settings.get() before attachExternalSync ever runs (settings.ts calls this
    // last), so reconciling any earlier would correct the store while leaving stale values
    // on screen. Running it here reuses listener two as the one and only repaint path
    // instead of adding a second one — adding a second repaint path is the exact defect
    // 01-05 already closed once. Everything from reading the host global to JSON.parse sits
    // inside one try/catch: a broken or absent localStorage, invalid JSON, or a getItem that
    // throws must never break a mount (T-L29-02) — reconciliation is best-effort only.
    try {
      const raw = window.localStorage?.getItem(SETTINGS_STORAGE_KEY);
      if (raw != null) replay(JSON.parse(raw));
    } catch {
      // best-effort only — see comment above
    }

    return function detach() {
      window.removeEventListener('storage', onStorage);
      listener.off();
    };
  }

  window.DnznSettingsSync = { diffAndReplay, attachExternalSync };
})();
