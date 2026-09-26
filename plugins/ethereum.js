(() => {
  const CHAINS = [
    { chainId: 1, name: "Ethereum Mainnet", explorer: "https://etherscan.io" },
    { chainId: 11155111, name: "Sepolia", explorer: "https://sepolia.etherscan.io" }
  ];
  function createEthereumPlugin() {
    return {
      name: "ethereum",
      settings: [
        { key: "etherscanApiKey", label: "Etherscan API Key", type: "text", default: "" },
        {
          key: "rpcUrl",
          label: "RPC URL",
          type: "text",
          default: "",
          // D-09: a user-supplied endpoint carries no CORS guarantee, and a refusal surfaces in
          // JS as an opaque failure with no status and no readable body — this is the only place
          // a user can be warned before they hit it.
          description: "Must allow browser requests (CORS) \u2014 a same-origin-only endpoint will fail with no useful error."
        },
        {
          key: "chainId",
          label: "Chain",
          type: "select",
          default: 1,
          options: CHAINS.map((c) => ({ label: c.name, value: String(c.chainId) }))
        },
        {
          key: "etherscanRps",
          label: "Etherscan requests/sec",
          type: "number",
          // D-12: Etherscan's free tier is 3 req/s, enforced per account and cumulative across
          // every key and chain. A bucket built for 5 is rate-limited in normal use — do not
          // "restore" this to 5.
          default: 3,
          validation: { min: 1, max: 5 }
        }
      ]
    };
  }
  window.DnznEthereum = { createEthereumPlugin, CHAINS };
})();
