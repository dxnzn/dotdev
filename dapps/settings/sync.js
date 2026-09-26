(() => {
  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
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
  const SETTINGS_STORAGE_KEY = "dnzn:dotdev:settings";
  function attachExternalSync(dx, opts) {
    function readCurrent(sectionId, key) {
      return dx.settings.get(sectionId, key);
    }
    function findDefinition(sectionId, key) {
      const sections = dx.settings.getSections?.() ?? [];
      for (const section of sections) {
        if (section.id !== sectionId) continue;
        for (const def of section.definitions || []) {
          if (def.key === key) return def;
        }
      }
      return void 0;
    }
    function replay(incoming) {
      const records = diffAndReplay(readCurrent, incoming, opts.isDirty);
      for (const record of records) {
        const def = findDefinition(record.sectionId, record.key);
        if (def && !window.DnznSettingsFields.validate(def, record.value).ok) continue;
        dx.settings.set(record.sectionId, record.key, record.value);
      }
    }
    function onStorage(e) {
      if (e.key !== SETTINGS_STORAGE_KEY || e.newValue == null) return;
      let incoming;
      try {
        incoming = JSON.parse(e.newValue);
      } catch {
        return;
      }
      replay(incoming);
    }
    function onSettingsChanged(detail) {
      const { dappId, key, value } = detail;
      if (opts.isDirty(dappId, key)) return;
      if (valuesEqual(opts.getSemanticValue(dappId, key), value)) return;
      opts.repaintField(dappId, key, value);
    }
    window.addEventListener("storage", onStorage);
    const listener = dx.events.on("dx:plugin:settings:changed", onSettingsChanged);
    try {
      const raw = window.localStorage?.getItem(SETTINGS_STORAGE_KEY);
      if (raw != null) replay(JSON.parse(raw));
    } catch {
    }
    return function detach() {
      window.removeEventListener("storage", onStorage);
      listener.off();
    };
  }
  window.DnznSettingsSync = { diffAndReplay, attachExternalSync };
})();
