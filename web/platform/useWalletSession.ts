import { useCallback, useEffect, useRef, useState } from 'react';
import { DemoWalletClient, WalletError } from '@beignet/wallet-core';
import type {
  CreatedWallet, CreateWalletInput, Network, WalletClientInterface,
  WalletRecord, WalletSnapshot,
} from '@beignet/wallet-core';
import { createHostWalletClient, UmbrelWalletClient } from './walletClient.ts';
import {
  defaultProfile, loadNetworkPreferences, saveNetworkPreferences, validateProfile,
} from '../chicory/src/services/networks.ts';
import type { NetworkProfile } from '../chicory/src/services/networks.ts';
import { mergeSnapshot } from '../chicory/src/services/activityMerge.ts';
import { loadCachedSnapshot, saveCachedSnapshot } from '../chicory/src/services/snapshotCache.ts';

export type Tab = 'Wallet' | 'Activity' | 'Settings';
export const STALE_AFTER_MS = 45000;
export const RECOVERY_DEADLINE_MS = 60000;
/** How often a wallet's start is looked at while it comes up, in ms. */
export const START_WATCH_MS = 300;
/** How long a start is followed, past Tor's own two minutes, in ms. */
export const START_WATCH_LIMIT_MS = 150000;
/**
 * The reads after the primary connects, in ms from the one that shows it, as
 * the phone has them: the handshake is done but the channel only counts as
 * spendable once it has been reestablished, a moment later.
 */
const CONNECT_READS_MS = [1500, 4500];
export const errorMessage = (error: unknown): string => error instanceof Error
  ? error.message : 'The wallet could not complete this action.';
export function primaryPubkey(snapshot: WalletSnapshot | null | undefined): string {
  const value = snapshot?.wallet.lfbw?.primaryPubkey ?? snapshot?.wallet.lfbw?.primaryUri?.split('@')[0];
  return typeof value === 'string' && /^0[23][a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : '';
}
export interface WalletSessionView {
  tab: Tab; onTab: (tab: Tab) => void; onCloseSheet: () => void; paused?: boolean;
}
export interface SessionDependencies {
  createHostClient: () => UmbrelWalletClient;
  createDemoClient: () => DemoWalletClient;
}
interface OpenOptions {
  restore?: boolean; existingOnly?: boolean; walletId?: string;
  prepared?: boolean; backupPending?: boolean; allowEmpty?: boolean;
}
type Remembered = {
  mode: 'host'; network: Network; walletId?: string; locked: boolean;
  prepared?: boolean; backupPending?: boolean;
};
type Action = { generation: number };
/** What the local service answers while a wallet's engine is on its way. */
const stillStarting = (cause: unknown) => cause instanceof WalletError &&
  (cause.code === 'NOT_RUNNING' || cause.code === 'PROXY_ERROR');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const KEY = 'chicory:host-selection';
const BACKUP = 'chicory:backup-pending:';
const factories: SessionDependencies = {
  createHostClient: createHostWalletClient,
  createDemoClient: () => new DemoWalletClient(),
};
function selectionStorage(): Storage {
  return typeof window !== 'undefined' && window.chicoryDesktop ? localStorage : sessionStorage;
}
function savedSelection(): { walletId?: string; locked?: boolean } {
  try {
    const value = JSON.parse(selectionStorage().getItem(KEY) ?? '{}');
    return {
      ...(typeof value?.walletId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.walletId)
        ? { walletId: value.walletId } : {}),
      locked: value?.locked === true,
    };
  } catch { return {}; }
}
function remember(walletId: string, locked: boolean) {
  try { selectionStorage().setItem(KEY, JSON.stringify({ walletId, locked })); }
  catch { /* Optional public preference. */ }
}
function pendingBackup(id: string): boolean {
  try { return localStorage.getItem(BACKUP + id) === 'true'; } catch { return true; }
}
/**
 * Whether a first launch may create its wallet without asking. Only the
 * desktop app does, never a plain browser, and not on a page loaded for
 * first-run setup (`?setup`), as after Erase all wallets, where Restore is
 * the question. The profile needs a server and a primary node: only mainnet
 * ships with both, so a test network still lands on the picker.
 */
function createsOnFirstRun(profile: NetworkProfile): boolean {
  if (typeof window === 'undefined' || !window.chicoryDesktop) return false;
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('setup')) return false;
  return !!profile.primaryUri.trim() && !!profile.electrum.host.trim();
}

/** The desktop service owns the engine and channel state. Unmounting detaches the view. */
export function useWalletSession(
  view: WalletSessionView,
  dependencies: SessionDependencies = factories,
) {
  const deps = useRef(dependencies);
  const demoMode = useRef(typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo'));
  const mounted = useRef(true);
  const callbacks = useRef(view);
  callbacks.current = view;
  const [client, setClient] = useState<WalletClientInterface | null>(null);
  const current = useRef<WalletClientInterface | null>(null);
  const [wallets, setWallets] = useState<WalletRecord[]>([]);
  const [walletId, setWalletId] = useState('');
  const selectedId = useRef('');
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null);
  const [activeProfile, setActiveProfile] = useState(() => defaultProfile('mainnet'));
  const profile = useRef(activeProfile);
  const [rememberedSession, setRememberedSession] = useState<Remembered | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<Network | null>(null);
  const [networkEditor, setNetworkEditor] = useState(false);
  const [deviceVisible, setDeviceVisible] = useState(false);
  const [deviceHint, setDeviceHint] = useState(false);
  const [error, setError] = useState('');
  const [switchError, setSwitchError] = useState('');
  const generation = useRef(0);
  const action = useRef<Action | null>(null);
  const reading = useRef<object | null>(null);
  const locks = useRef(0);
  // The start being followed (`watchStart`), a newer one taking over.
  const watching = useRef<object | null>(null);
  const watchStart = useRef<(adapter: UmbrelWalletClient, id: string, alreadyLive: boolean) => Promise<void>>(async () => {});
  const [starting, setStarting] = useState(false);

  const setProfile = useCallback((value: NetworkProfile) => {
    profile.current = value; setActiveProfile(value);
  }, []);
  const begin = useCallback((replace = false): Action => {
    if (action.current && !replace)
      throw new WalletError('Wait for the current wallet action to finish.', 'ACTION_IN_PROGRESS');
    const token = { generation: ++generation.current };
    action.current = token; reading.current = null;
    setConnecting(false); setSelecting(false); setRefreshing(false);
    setClosing(false); setSwitching(false); setSwitchTarget(null);
    return token;
  }, []);
  const valid = useCallback((token: Action, adapter?: WalletClientInterface) =>
    mounted.current && action.current === token && generation.current === token.generation &&
      (!adapter || current.current === adapter), []);
  const finish = useCallback((token: Action) => {
    // An old operation cannot release a newer operation's latch or flags.
    if (!mounted.current || action.current !== token) return;
    action.current = null;
    setConnecting(false); setSelecting(false); setRefreshing(false);
    setClosing(false); setSwitching(false); setSwitchTarget(null);
    setInitializing(false);
  }, []);
  /**
   * A live read of wallet `id`, merged over what is shown so known history is
   * never dropped, and saved as that wallet's encrypted cached view on
   * desktop, so the next launch opens on it.
   */
  const land = useCallback((id: string, read: WalletSnapshot) => {
    setSnapshot(old => {
      const next = old?.wallet.id === id ? mergeSnapshot(old, read) : read;
      if (!demoMode.current && typeof window !== 'undefined' && window.chicoryDesktop) void saveCachedSnapshot(id, next);
      return next;
    });
  }, []);
  const makeRaw = useCallback((): WalletClientInterface => demoMode.current
    ? deps.current.createDemoClient() : deps.current.createHostClient(), []);

  const activate = useCallback(async (
    adapter: WalletClientInterface, wallet: WalletRecord, backup: boolean, token: Action,
  ) => {
    if (!valid(token, adapter)) return;
    const previous = selectedId.current;
    if (previous && previous !== wallet.id && adapter instanceof UmbrelWalletClient) {
      await adapter.stopWallet();
      if (!valid(token, adapter)) return;
    }
    adapter.selectWallet(wallet.id);
    selectedId.current = wallet.id; setWalletId(wallet.id); setSnapshot(null);
    setWallets(old => [...old.filter(item => item.id !== wallet.id), wallet]);
    if (profile.current.network !== wallet.network) setProfile(defaultProfile(wallet.network));
    setRememberedSession({ mode: 'host', network: wallet.network, walletId: wallet.id, locked: false, backupPending: backup });
    setDeviceHint(true);
    if (!demoMode.current) remember(wallet.id, false);
    callbacks.current.onCloseSheet(); callbacks.current.onTab('Wallet');
    // A returning wallet opens on its last confirmed view while the engine
    // starts. It reads disconnected, keeps its original time so it is stale
    // and can authorize nothing, and only fills a page still empty for this
    // wallet: a late cache read never covers a live one or another wallet.
    if (!demoMode.current && typeof window !== 'undefined' && window.chicoryDesktop) {
      void loadCachedSnapshot(wallet.id).then(cached => {
        if (cached && cached.wallet.id === wallet.id && valid(token, adapter) && selectedId.current === wallet.id)
          setSnapshot(old => old ?? cached);
      });
    }
    await adapter.startWallet();
    if (!valid(token, adapter)) return;
    // A start returns before the engine exists, while Tor and the daemon come
    // up, so a first read can lose the race. That is a wallet still opening,
    // not a failure: it stays on its loading page or cached view, and the
    // start is followed from here instead of waiting for the next poll.
    let read: WalletSnapshot | null = null;
    try { read = await adapter.snapshot(); }
    catch (cause) { if (!stillStarting(cause)) throw cause; }
    if (read && valid(token, adapter) && selectedId.current === wallet.id && read.wallet.id === wallet.id) {
      land(wallet.id, read); setError('');
    }
    if (valid(token, adapter) && !read?.primary.connected && adapter instanceof UmbrelWalletClient)
      void watchStart.current(adapter, wallet.id, !!read);
  }, [land, setProfile, valid]);

  const wrapClient = useCallback((raw: WalletClientInterface): WalletClientInterface => {
    let exposed: WalletClientInterface;
    const create = async (input?: CreateWalletInput): Promise<CreatedWallet> => {
      if (current.current !== exposed || !mounted.current)
        throw new WalletError('Reopen the wallet before creating one.', 'WALLET_CHANGED');
      const token = begin();
      const lockAt = locks.current;
      setSelecting(true); setError('');
      // Creation gets its own client. Its automatic core selection cannot
      // change the displayed wallet or invalidate a newer session's requests.
      const creator = makeRaw();
      try {
        if (selectedId.current && raw instanceof UmbrelWalletClient) {
          await raw.stopWallet();
          if (!valid(token, exposed)) throw new WalletError('The selected wallet changed.', 'WALLET_CHANGED');
        }
        const created = await creator.createWallet(input);
        // Only a phrase the service has just made is still to be saved. A
        // restored or reused phrase is one the owner already holds.
        if (!demoMode.current && typeof created.mnemonic === 'string') {
          try { localStorage.setItem(BACKUP + created.id, 'true'); }
          catch { /* The current session still requires acknowledgement. */ }
        }
        if (!valid(token, exposed)) {
          // A lock can overtake a create. Stop a known late-created daemon.
          // A tab closing alone leaves the daemon running, like any other tab.
          if (locks.current !== lockAt && creator instanceof UmbrelWalletClient)
            await creator.stopWallet().catch(() => {});
          throw new WalletError('The selected wallet changed. Reopen the wallet to continue.', 'WALLET_CHANGED');
        }
        const { mnemonic: _phrase, warnings: _warnings, ...record } = created;
        setWallets(old => [...old.filter(item => item.id !== record.id), record]);
        setDeviceHint(true);
        if (!demoMode.current) remember(record.id, false);
        return created;
      } finally { finish(token); }
    };
    exposed = new Proxy(raw, {
      get(target, property) {
        if (property === 'createWallet') return create;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return exposed;
  }, [begin, finish, makeRaw, valid]);

  const selectWallet = useCallback(async (
    wallet: WalletRecord, created = false,
    backup = created ? false : !demoMode.current && pendingBackup(wallet.id),
  ) => {
    const adapter = current.current;
    if (!adapter) throw new WalletError('Open your wallet first.', 'NO_WALLET');
    const token = begin();
    setSelecting(true); setConnecting(true); setError('');
    try {
      // The shared CreateSheet calls onCreated only after its backup control.
      if (created && !backup && !demoMode.current) localStorage.removeItem(BACKUP + wallet.id);
      await activate(adapter, wallet, backup, token);
    } catch (cause) { if (valid(token, adapter)) setError(errorMessage(cause)); throw cause; }
    finally { finish(token); }
  }, [activate, begin, finish, valid]);

  const connect = useCallback(async (
    input?: NetworkProfile | { restore?: boolean }, options: OpenOptions = {}, automatic = false,
  ) => {
    const token = begin();
    setConnecting(true); setError('');
    const configured = input && 'network' in input ? input : undefined;
    const restoring = options.restore === true || (input && 'restore' in input && input.restore === true);
    try {
      if (configured) validateProfile(configured, true);
      const adapter = current.current ?? wrapClient(makeRaw());
      if (restoring && selectedId.current && adapter instanceof UmbrelWalletClient) {
        await adapter.stopWallet();
        if (!valid(token)) return;
      }
      const [config, records, preferences] = await Promise.all([
        adapter.getConfig(), adapter.listWallets(), loadNetworkPreferences(),
      ]);
      if (!valid(token)) return;
      const saved = demoMode.current ? {} : savedSelection();
      const requested = options.walletId ?? saved.walletId;
      const candidates = configured ? records.filter(item => item.network === configured.network) : records;
      const selected = candidates.find(item => item.id === requested) ??
        candidates.find(item => item.network === (configured?.network ?? preferences.selectedNetwork)) ??
        (configured ? undefined : candidates[0]);
      const network = configured?.network ?? selected?.network ?? config.defaultNetwork ?? preferences.selectedNetwork;
      setProfile(configured ?? {
        ...preferences.profiles[network],
        ...(config.defaultElectrum ? { electrum: config.defaultElectrum } : {}),
      });
      setWallets(records); setDeviceHint(records.length > 0);
      setNetworkEditor(false); setDeviceVisible(false);
      if (automatic && saved.locked && selected) {
        current.current = null; setClient(null); selectedId.current = ''; setWalletId(''); setSnapshot(null);
        setRememberedSession({ mode: 'host', network: selected.network, walletId: selected.id, locked: true });
        return;
      }
      current.current = adapter; setClient(adapter);
      if (restoring || !selected) {
        selectedId.current = ''; setWalletId(''); setSnapshot(null); setRememberedSession(null);
        callbacks.current.onCloseSheet();
        // A first launch has nothing here and nothing ever chosen, so there is
        // no question to put to anyone: the wallet makes itself, as on the
        // phone, and its recovery phrase waits behind the backup banner. A
        // failure leaves the picker, the manual way in, with the reason.
        if (automatic && !restoring && !configured && records.length === 0 && !saved.walletId &&
          !demoMode.current && createsOnFirstRun(profile.current)) {
          const lockAt = locks.current;
          const creator = makeRaw();
          const first = profile.current;
          const created = await creator.createWallet({
            name: 'My wallet', network: first.network,
            primaryUri: first.primaryUri, electrum: first.electrum,
          });
          if (typeof created.mnemonic === 'string') {
            try { localStorage.setItem(BACKUP + created.id, 'true'); }
            catch { /* The current session still requires acknowledgement. */ }
          }
          if (!valid(token, adapter)) {
            // A lock can overtake the create. Stop a known late-created daemon.
            if (locks.current !== lockAt && creator instanceof UmbrelWalletClient)
              await creator.stopWallet().catch(() => {});
            return;
          }
          const { mnemonic: _phrase, warnings: _warnings, ...record } = created;
          await activate(adapter, record, true, token);
        }
        return;
      }
      await activate(adapter, selected, options.backupPending ?? (!demoMode.current && pendingBackup(selected.id)), token);
    } catch (cause) {
      if (valid(token)) setError(errorMessage(cause));
      if (!automatic) throw cause;
    }
    finally { finish(token); }
  }, [activate, begin, finish, makeRaw, setProfile, valid, wrapClient]);
  const openWallet = useCallback(async (
    input?: NetworkProfile | { restore?: boolean }, options?: OpenOptions,
  ) => connect(input, options), [connect]);
  const openDevice = openWallet;

  /** One read of the wallet, onto the page, which it returns if it landed. */
  const readLive = useCallback(async (): Promise<WalletSnapshot | null> => {
    const adapter = current.current;
    const id = selectedId.current;
    if (!adapter || !id || adapter.connection.walletId !== id || reading.current || action.current) return null;
    const at = generation.current;
    const token = {};
    reading.current = token;
    const stillCurrent = () => mounted.current && reading.current === token &&
      generation.current === at && current.current === adapter && selectedId.current === id &&
      adapter.connection.walletId === id;
    try {
      const read = await adapter.snapshot();
      if (stillCurrent() && read.wallet.id === id) {
        land(id, read); setError('');
        return read;
      }
    } catch (cause) {
      // While a start is followed, an engine not up yet is no news.
      if (stillCurrent() && !(watching.current && stillStarting(cause))) setError(errorMessage(cause));
    } finally { if (reading.current === token) reading.current = null; }
    return null;
  }, [land]);
  const refresh = useCallback(async () => { await readLive(); }, [readLive]);
  /**
   * Follows a wallet's start, so the page goes live and the dot turns green
   * as they happen rather than on the next 12 second poll. It holds nothing:
   * a lock, a switch or a refresh goes ahead, and ends it if the wallet goes.
   * A read that an action held back is tried again, and the poll stays as the
   * backstop for one that outlasts it.
   */
  watchStart.current = async (adapter, id, alreadyLive) => {
    const run = {};
    watching.current = run;
    const following = () => mounted.current && watching.current === run &&
      current.current === adapter && selectedId.current === id && adapter.connection.walletId === id;
    const deadline = Date.now() + START_WATCH_LIMIT_MS;
    let live = alreadyLive;
    setStarting(!live);
    try {
      while (following() && Date.now() < deadline) {
        const state = await adapter.startState().catch(() => null);
        if (!following()) return;
        if (state?.failed) { setError(state.failed); return; }
        if (state?.running && (!live || state.primaryConnected)) {
          const read = await readLive();
          if (!following()) return;
          if (read) { live = true; setStarting(false); }
          if (read?.primary.connected) {
            for (const wait of CONNECT_READS_MS) {
              await pause(wait);
              if (!following()) return;
              await readLive();
            }
            return;
          }
        }
        await pause(START_WATCH_MS);
      }
    } finally {
      if (watching.current === run) { watching.current = null; if (mounted.current) setStarting(false); }
    }
  };
  useEffect(() => {
    if (!client || !walletId) return;
    const wake = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = setInterval(wake, 12000);
    document.addEventListener('visibilitychange', wake);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', wake); };
  }, [client, walletId, refresh]);

  const manualRefresh = useCallback(async () => {
    const adapter = current.current;
    const id = selectedId.current;
    if (!adapter || !id) return;
    const token = begin();
    setRefreshing(true); setError('');
    try {
      await adapter.startWallet();
      if (!valid(token, adapter)) return;
      await adapter.refreshWallet();
      if (!valid(token, adapter)) return;
      const read = await adapter.snapshot();
      if (valid(token, adapter) && selectedId.current === id && read.wallet.id === id)
        land(id, read);
    } catch (cause) { if (valid(token, adapter)) setError(errorMessage(cause)); }
    finally { finish(token); }
  }, [begin, finish, land, valid]);
  const createDefaultWallet = useCallback(async () => {
    const adapter = current.current;
    if (!adapter) return;
    const at = generation.current;
    try {
      const selected = profile.current;
      const created = await adapter.createWallet({
        name: 'My wallet', network: selected.network,
        primaryUri: selected.primaryUri, electrum: selected.electrum,
      });
      if (!mounted.current || generation.current !== at + 1 || current.current !== adapter) return;
      const { mnemonic: _phrase, warnings: _warnings, ...record } = created;
      await selectWallet(record, true, !demoMode.current);
    } catch (cause) {
      if (mounted.current && generation.current === at + 1 && current.current === adapter)
        setError(errorMessage(cause));
    }
  }, [selectWallet]);

  const switchNetwork = useCallback(async (next: NetworkProfile) => {
    // A network with no server is refused before anything stops, and the
    // reason is kept where Settings shows it, not only thrown at the button.
    try { validateProfile(next, true); }
    catch (cause) { if (mounted.current) setSwitchError(errorMessage(cause)); throw cause; }
    const adapter = current.current;
    if (!adapter) throw new WalletError('Open your wallet first.', 'NO_WALLET');
    const token = begin();
    setSwitching(true); setSwitchTarget(next.network); setSwitchError('');
    try {
      if (next.network === profile.current.network && selectedId.current && adapter instanceof UmbrelWalletClient) {
        await adapter.updateWalletSettings({ electrum: next.electrum });
        if (!valid(token, adapter)) return;
      }
      const [records, preferences] = await Promise.all([adapter.listWallets(), loadNetworkPreferences()]);
      if (!valid(token, adapter)) return;
      const selected = records.find(item => item.id === selectedId.current && item.network === next.network) ??
        records.find(item => item.network === next.network);
      if (!selected && selectedId.current && adapter instanceof UmbrelWalletClient) {
        await adapter.stopWallet();
        if (!valid(token, adapter)) return;
      }
      preferences.selectedNetwork = next.network;
      preferences.profiles[next.network] = next;
      await saveNetworkPreferences(preferences);
      if (!valid(token, adapter)) return;
      setProfile(next); setWallets(records); setNetworkEditor(false);
      if (selected) await activate(adapter, selected, !demoMode.current && pendingBackup(selected.id), token);
      else {
        selectedId.current = ''; setWalletId(''); setSnapshot(null); setRememberedSession(null);
        if (!demoMode.current) remember('', false);
        callbacks.current.onCloseSheet();
      }
    } catch (cause) { if (valid(token, adapter)) setSwitchError(errorMessage(cause)); throw cause; }
    finally { finish(token); }
  }, [activate, begin, finish, setProfile, valid]);

  const disconnect = useCallback(async () => {
    // Lock can overtake a slow connection, create, read or network switch.
    const token = begin(true);
    locks.current++;
    const adapter = current.current;
    const id = selectedId.current;
    setClosing(true);
    try {
      if (!adapter) return;
      if (adapter instanceof UmbrelWalletClient && adapter.connection.walletId) await adapter.stopWallet();
      if (!valid(token, adapter)) return;
      if (!demoMode.current) remember(id, true);
      current.current = null; setClient(null); selectedId.current = ''; setWalletId(''); setSnapshot(null);
      setRememberedSession(old => old ? { ...old, locked: true } : null);
      callbacks.current.onCloseSheet(); setError('');
    } catch (cause) {
      // An unconfirmed stop keeps the wallet visible. The released read latch
      // permits a fresh poll instead of falsely claiming successful lock.
      if (valid(token, adapter ?? undefined)) setError(errorMessage(cause));
    } finally { finish(token); }
  }, [begin, finish, valid]);
  const acknowledgeBackup = useCallback(() => {
    const id = selectedId.current;
    if (!id) return;
    if (!demoMode.current) {
      try { localStorage.removeItem(BACKUP + id); }
      catch { setError('Chicory could not remember the backup acknowledgement.'); return; }
    }
    setRememberedSession(old => old?.walletId === id ? { ...old, backupPending: false } : old);
  }, []);
  /**
   * Erases every wallet in this profile through the desktop host, which
   * stops the engines, deletes the profile's wallet data and stored state,
   * and reloads into first-run setup. A refusal or partial erase is thrown
   * for the panel to show, and the erase can be retried.
   */
  const eraseDevice = useCallback(async () => {
    const erase = typeof window !== 'undefined' ? window.chicoryDesktop?.erase : undefined;
    if (!erase) throw new WalletError('Erasing is not available here.', 'ERASE_UNAVAILABLE');
    // Overtakes any read, create or switch, so none of them writes after this.
    const token = begin(true);
    // Closing and erasing together draw the erase transit over every scene.
    setErasing(true); setClosing(true); setError('');
    try {
      const result = await erase();
      if (!result?.ok)
        throw new WalletError(result?.error || 'Could not erase the wallets.', result?.code || 'ERASE_FAILED');
      // The host reloads this page into first-run setup once it is done.
    } catch (cause) {
      // The transit may have replaced the panel that asked, so the session says it too.
      if (mounted.current) setError(errorMessage(cause));
      throw cause;
    } finally {
      if (mounted.current) setErasing(false);
      finish(token);
    }
  }, [begin, finish]);
  const retrySetup = useCallback(async () => {
    const adapter = current.current;
    if (!adapter || !selectedId.current) return;
    const token = begin();
    setRefreshing(true); setError('');
    try {
      await adapter.retrySetup();
      if (!valid(token, adapter)) return;
      const read = await adapter.snapshot();
      if (valid(token, adapter) && read.wallet.id === selectedId.current)
        setSnapshot(old => old?.wallet.id === read.wallet.id ? mergeSnapshot(old, read) : read);
    } catch (cause) { if (valid(token, adapter)) setError(errorMessage(cause)); }
    finally { finish(token); }
  }, [begin, finish, valid]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      action.current = null; reading.current = null; current.current = null;
    };
  }, []);
  useEffect(() => {
    // A pause with nothing open or under way, as while the app lock is still
    // being checked at launch, has nothing to close. Closing anyway would end
    // the opening wait and draw first-run setup for a moment.
    if (view.paused) { if (current.current || action.current) void disconnect(); }
    else void connect(undefined, {}, true).catch(() => {});
  }, [view.paused, connect, disconnect]);

  return {
    client, wallets, walletId, snapshot, activeProfile, rememberedSession, deviceHint,
    initializing, connecting: connecting || starting, selecting, refreshing, closing, erasing,
    switching, switchTarget, switchError, networkEditor, deviceVisible, error,
    setError, setSwitchError, setNetworkEditor, setDeviceVisible, refresh, manualRefresh,
    retrySetup, selectWallet, openDevice, openWallet, createDefaultWallet,
    switchNetwork, disconnect, acknowledgeBackup,
    eraseDevice: !demoMode.current && typeof window !== 'undefined' && window.chicoryDesktop?.erase
      ? eraseDevice : undefined,
  };
}
