// Schema-only DxKit plugin — declares the "auto-run shared links" toggle (G-06-6, DEC-05
// amendment ratified 06-10). Deliberately its own section rather than folded into `ethereum`'s:
// the setting gates decode's auto-run behavior for EVERY decoder a shared link can name — hex,
// base64, jwt, url and abi-words included, none of which are Ethereum credentials — so it does
// not belong under a heading a reader would reasonably assume is chain-specific.
//
// No init()/destroy(), matching src/plugins/ethereum.ts: plugin registration completes before
// any init() runs (src/vendor/dxkit/index.global.js `init()`), so a settings-only plugin
// participates in dx.settings.getSections() with nothing else to do.
(() => {
  function createLinksPlugin() {
    return {
      name: 'links',
      settings: [
        {
          key: 'autoRunSharedLinks',
          label: 'Auto-run shared links',
          type: 'boolean',
          // Off by default — this is the whole point of routing consent through a setting rather
          // than through the link's own submit=1: the sender composed the link, not the
          // recipient, and cannot be expected to read a query parameter and understand what it
          // costs. See the description below for what "costs" means concretely.
          default: false,
          description:
            'When a decode link carries submit=1, decode it immediately instead of only loading ' +
            'it — for every kind of payload, including one requiring Ethereum lookups. Even with ' +
            'no credentials configured, this can send a function selector to public keyless ' +
            'registries (api.openchain.xyz, 4byte.directory) the moment the link opens; with an ' +
            'Etherscan key and RPC URL configured, it also spends your own request quota. Off by ' +
            "default so opening someone else's link never starts network work on your behalf " +
            'without you having already agreed to it here.',
        },
      ],
    };
  }

  window.DnznLinks = { createLinksPlugin };
})();
