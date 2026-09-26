// Schema-only DxKit plugin — declares the global Ethereum credential settings.
// No init()/destroy(): plugin registration completes before any init() runs
// (src/vendor/dxkit/index.global.js `init()`), so a settings-only plugin
// participates in dx.settings.getSections() with nothing else to do.
// The chainId -> explorer table is exported alongside the factory; Phase 5
// reads this same table for its address links.

(() => {
  const CHAINS = [
    { chainId: 1, name: 'Ethereum Mainnet', explorer: 'https://etherscan.io' },
    { chainId: 11155111, name: 'Sepolia', explorer: 'https://sepolia.etherscan.io' },
  ];

  function createEthereumPlugin() {
    return {
      name: 'ethereum',
      settings: [
        { key: 'etherscanApiKey', label: 'Etherscan API Key', type: 'text', default: '' },
        { key: 'rpcUrl', label: 'RPC URL', type: 'text', default: '' },
        {
          key: 'chainId',
          label: 'Chain',
          type: 'select',
          default: 1,
          options: CHAINS.map((c) => ({ label: c.name, value: String(c.chainId) })),
        },
        {
          key: 'etherscanRps',
          label: 'Etherscan requests/sec',
          type: 'number',
          default: 5,
          validation: { min: 1, max: 5 },
        },
      ],
    };
  }

  window.DnznEthereum = { createEthereumPlugin, CHAINS };
})();
