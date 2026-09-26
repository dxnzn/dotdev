(() => {
  function createLinksPlugin() {
    return {
      name: "links",
      settings: [
        {
          key: "autoRunSharedLinks",
          label: "Auto-run shared links",
          type: "boolean",
          // Off by default — this is the whole point of routing consent through a setting rather
          // than through the link's own submit=1: the sender composed the link, not the
          // recipient, and cannot be expected to read a query parameter and understand what it
          // costs. See the description below for what "costs" means concretely.
          default: false,
          description: "When a decode link carries submit=1, decode it immediately instead of only loading it \u2014 for every kind of payload, including one requiring Ethereum lookups. Even with no credentials configured, this can send a function selector to public keyless registries (api.openchain.xyz, 4byte.directory) the moment the link opens; with an Etherscan key and RPC URL configured, it also spends your own request quota. Off by default so opening someone else's link never starts network work on your behalf without you having already agreed to it here."
        }
      ]
    };
  }
  window.DnznLinks = { createLinksPlugin };
})();
