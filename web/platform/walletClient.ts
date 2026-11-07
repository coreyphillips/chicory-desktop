import { WalletClient, WalletError } from '@beignet/wallet-core';
import type { ActivityStore, CreatedWallet, CreateWalletInput, ElectrumServer, Network } from '@beignet/wallet-core';

/** The wallet whose recovery phrase a new wallet on another network reuses. */
export interface SeedReference { walletId: string; network: Network; nodeId?: string }
/** One client's create request, for the transport to send its seed reference. */
interface PendingCreate { seedFrom?: SeedReference }

// These satisfy wallet-core's remote-host connection shape. Neither value is a
// credential or a network destination: the injected transport consumes both.
const TRANSPORT_ORIGIN = 'http://127.0.0.1';
const TRANSPORT_MARKER = 'desktop-session-cookie';

export interface HostWalletClientOptions {
  walletId?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  store?: ActivityStore;
}

/** Keep wallet-core's request handling over the authenticated local session. */
export function createSameOriginWalletFetch(
  request: typeof globalThis.fetch = globalThis.fetch,
  pending: PendingCreate = {},
): typeof globalThis.fetch {
  return async (input, init = {}) => {
    // WalletClient always supplies its synthetic origin plus an API path.
    // Reject other callers rather than forwarding cookies to an arbitrary URL.
    const url = new URL(String(input));
    if (
      url.origin !== TRANSPORT_ORIGIN ||
      url.username ||
      url.password ||
      url.hash ||
      !/^\/(?:api|wallets)\//.test(url.pathname)
    ) {
      throw new WalletError('Choose a valid wallet API path.', 'INVALID_URL');
    }

    let path = url.pathname + url.search;
    let method = init.method ?? 'GET';
    let body = init.body;

    // The manager deliberately reveals phrases through POST rather than the
    // daemon GET route, so links and prefetches cannot retrieve them.
    const phrase = /^\/wallets\/([a-zA-Z0-9_-]{1,128})\/api\/mnemonic$/.exec(path);
    if (method === 'GET' && phrase) {
      path = `/api/wallets/${phrase[1]}/recovery-phrase`;
      method = 'POST';
      body = '{}';
    }

    // The manager's create route generates a seed even when given a mnemonic.
    // A restore must go through its separate import route, exactly once.
    if (method === 'POST' && path === '/api/wallets' && typeof body === 'string') {
      const inputBody = JSON.parse(body);
      if (Object.prototype.hasOwnProperty.call(inputBody, 'mnemonic')) {
        path = '/api/wallets/import';
      } else if (pending.seedFrom) {
        // The service reads the named wallet's phrase itself. Only the
        // reference travels, never the phrase.
        body = JSON.stringify({ ...inputBody, seedFrom: pending.seedFrom });
      }
    }

    const response = await request(path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      ...(init.signal ? { signal: init.signal } : {}),
    });
    if (method !== 'GET' || !/^\/wallets\/[^/]+\/api\/payments$/.test(path) || !response.ok)
      return response;
    const packet = await response.clone().json();
    if (packet?.ok === false || !Array.isArray(packet?.result)) return response;
    const rows = packet.result.map((payment: Record<string, unknown>) => {
      if (payment.direction !== 'OUTGOING' || payment.status !== 'COMPLETED' || payment.payAll ||
          payment.amountSemantics !== 'total-debit-including-fee') return payment;
      if (payment.feeSats == null) return payment;
      if (!Number.isSafeInteger(payment.amountSats) || !Number.isSafeInteger(payment.feeSats) ||
          (payment.feeSats as number) < 0 || (payment.feeSats as number) > (payment.amountSats as number))
        throw new WalletError('The wallet could not verify this payment amount and fee.', 'INVALID_RESPONSE');
      return { ...payment, debitSats: payment.amountSats,
        amountSats: (payment.amountSats as number) - (payment.feeSats as number),
        amountSemantics: 'recipient-amount' };
    });
    const headers = new Headers(response.headers);
    headers.delete('Content-Length'); headers.delete('Content-Encoding');
    return new Response(JSON.stringify({ ...packet, result: rows }), {
      status: response.status, statusText: response.statusText, headers,
    });
  };
}

/** How a wallet's start stands, as the local service sees it (`startState`). */
export interface StartState {
  /** The engine answers. */
  running: boolean;
  /** The primary node is connected. */
  primaryConnected: boolean;
  /** The start failed, in these words. */
  failed?: string;
}

/** What the local service records of a wallet, as `startState` reads it. */
interface StartRecord {
  status?: string;
  healthy?: boolean;
  lastStartError?: { message?: string } | null;
  lfbw?: { primaryPubkey?: string };
}

/** What the engine says of a peer. */
interface Peer { pubkey?: string; state?: string; connected?: boolean }

export class UmbrelWalletClient extends WalletClient {
  // wallet-core's pinned runtime provides this transport method. Declaring its
  // existing signature lets host settings and stop actions use its response and
  // uncertain-result handling too, without duplicating payment transport code.
  declare protected _request: (
    path: string,
    method?: string,
    body?: unknown,
    readOnly?: boolean,
  ) => Promise<unknown>;
  declare protected _get: (path: string) => Promise<unknown>;
  declare protected _record: () => Promise<unknown>;

  private readonly pendingCreate: PendingCreate;

  constructor(options: HostWalletClientOptions = {}) {
    const pending: PendingCreate = {};
    super(
      {
        url: TRANSPORT_ORIGIN,
        token: TRANSPORT_MARKER,
        ...(options.walletId ? { walletId: options.walletId } : {}),
      },
      {
        fetch: createSameOriginWalletFetch(options.fetch, pending),
        now: options.now,
        store: options.store,
      },
    );
    this.pendingCreate = pending;
  }

  /**
   * With `seedFrom`, the new wallet reuses that wallet's recovery phrase
   * inside the local service, for a wallet on another network. The reference
   * applies to this one request only.
   */
  override async createWallet(input?: CreateWalletInput & { seedFrom?: SeedReference }): Promise<CreatedWallet> {
    const { seedFrom, ...rest } = input ?? {};
    if (!seedFrom) return super.createWallet(rest);
    if (rest.mnemonic !== undefined)
      throw new WalletError('A restored phrase and a reused phrase cannot be combined.', 'INVALID_PARAMS');
    if (this.pendingCreate.seedFrom) throw new WalletError('Wait for the current wallet to be created.', 'ACTION_IN_PROGRESS');
    this.pendingCreate.seedFrom = { walletId: seedFrom.walletId, network: seedFrom.network, ...(seedFrom.nodeId ? { nodeId: seedFrom.nodeId } : {}) };
    try { return await super.createWallet(rest); }
    finally { this.pendingCreate.seedFrom = undefined; }
  }

  /**
   * How the wallet's start stands, for a page to follow it closely: from the
   * local service's record, with one read of the engine's peers once it
   * answers. Much lighter than a snapshot, so it can be asked often.
   */
  async startState(): Promise<StartState> {
    const record = await this._record() as StartRecord;
    if (record.status === 'error')
      return { running: false, primaryConnected: false, failed: record.lastStartError?.message || 'The wallet could not start.' };
    if (!record.healthy) return { running: false, primaryConnected: false };
    const primary = record.lfbw?.primaryPubkey;
    const peers = primary ? await this._get('/peers').catch(() => null) : null;
    return {
      running: true,
      primaryConnected: Array.isArray(peers) && peers.some((peer: Peer) => peer.pubkey === primary &&
        (peer.state === 'connected' || peer.state === 'ready' || peer.connected === true)),
    };
  }

  async stopWallet(): Promise<void> {
    const id = this.connection.walletId;
    if (!id) throw new WalletError('Choose a wallet first.', 'NO_WALLET');
    await this._request(`/api/wallets/${encodeURIComponent(id)}/stop`, 'POST', {});
  }

  async updateWalletSettings({
    electrum,
  }: { electrum: ElectrumServer }): Promise<void> {
    const id = this.connection.walletId;
    if (!id) throw new WalletError('Choose a wallet first.', 'NO_WALLET');
    // A manager settings update can restart the daemon. Invalidate reviews and
    // reads already in flight before beginning it, including an uncertain PATCH.
    this.selectWallet(id);
    const connection = this.connection;
    await this._request(`/api/wallets/${encodeURIComponent(id)}`, 'PATCH', { electrum });
    if (this.connection !== connection) {
      throw new WalletError(
        'The selected wallet changed. Refresh before continuing.',
        'WALLET_CHANGED',
      );
    }
  }
}

export function createHostWalletClient(
  options: HostWalletClientOptions = {},
): UmbrelWalletClient {
  return new UmbrelWalletClient(options);
}
