import type { Wallet, WalletProvider } from '@dnzn/dxkit';
import '@dnzn/dxkit-settings';
declare module '@dnzn/dxkit' {
    interface EventMap {
        'dx:plugin:wallet:connected': {
            address: string;
            chainId: number;
        };
        'dx:plugin:wallet:disconnected': Record<string, never>;
        'dx:plugin:wallet:changed': {
            address: string;
            chainId: number;
        };
    }
}
/** Creates a wallet provider using the browser's injected EIP-1193 provider (window.ethereum). */
export declare function createEIP1193Provider(): WalletProvider;
export interface LocalWalletProviderOptions {
    /** Override the deterministic address. Default: '0x0000000000000000000000000000000001' */
    address?: string;
}
/** Creates a local dev wallet provider. Instant connect, deterministic address. */
export declare function createLocalWalletProvider(options?: LocalWalletProviderOptions): WalletProvider;
export interface WalletOptions {
    /** Available wallet providers. First available is used by default. */
    providers: WalletProvider[];
    /** localStorage key for the persisted provider selection. Default: 'dxkit:wallet'. */
    storageKey?: string;
}
/** Creates the wallet Context plugin — a coordinator that delegates to pluggable providers. */
export declare function createWallet(options: WalletOptions): Wallet;
/**
 * @deprecated Use `createWallet({ providers: [createEIP1193Provider()] })` instead.
 */
export declare function createEthereumWallet(): Wallet;
