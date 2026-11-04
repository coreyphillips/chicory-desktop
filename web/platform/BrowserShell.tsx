import React, { useEffect } from 'react';
import type { PropsWithChildren } from 'react';
import { Glyph } from '../chicory/src/design/glyphs';
import type { GlyphName } from '../chicory/src/design/glyphs';
import { Bloom } from '../chicory/src/glyphs/Bloom';
import { useStage } from '../chicory/src/stage/StageContext';
import type { useWalletSession } from './useWalletSession';
import type { Phase } from '../chicory/src/stage/phase';
import { normalizePaymentLink } from '../chicory/src/services/links';
import { commandAccepted, desktopScene, desktopShortcut } from './desktop';
import { editableTarget } from './keyboard';

const navigation: { name: 'home' | 'send' | 'receive' | 'activity' | 'settings'; label: string; glyph: GlyphName }[] = [
  { name: 'home', label: 'Overview', glyph: 'wallet' },
  { name: 'send', label: 'Send', glyph: 'send' },
  { name: 'receive', label: 'Receive', glyph: 'receive' },
  { name: 'activity', label: 'Activity', glyph: 'clock' },
  { name: 'settings', label: 'Settings', glyph: 'cog' },
];

export function BrowserShell({ session, phase, children }: PropsWithChildren<{
  session: ReturnType<typeof useWalletSession>; phase: Phase;
}>) {
  const { state, actions, dispatch } = useStage();
  const wallet = session.snapshot?.wallet;
  const active = state.scene.name === 'detail' ? 'activity' : state.scene.name;
  const ready = phase.kind === 'wallet' && !!wallet;
  const choosing = session.connecting || session.selecting || session.switching || session.closing;
  const desktop = window.chicoryDesktop;
  const modifier = desktop?.platform === 'darwin' || (!desktop && /Mac/.test(navigator.platform)) ? '⌘' : 'Ctrl+';
  const shortcuts: Record<string, string> = { home: '1', send: '2', receive: '3', activity: '4', settings: ',' };
  useEffect(() => {
    const command = (name: string, value?: string) => {
      // The same guard covers native menus, shortcuts and external payment links.
      // A link only fills Send and is dropped while a wallet is not ready.
      if (!commandAccepted({ ready, choosing, busy: state.busy, overlay: state.overlay })) return;
      if (name === 'payment-link') {
        const request = normalizePaymentLink(value);
        if (request) dispatch({ type: 'link', request });
        return;
      }
      const scene = desktopScene(name);
      if (scene) actions.navigate(scene);
    };
    if (desktop) return desktop.onCommand(command);
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || editableTarget(event.target)) return;
      const scene = desktopShortcut(event);
      if (!scene) return;
      event.preventDefault();
      command(scene);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [desktop, ready, choosing, state.busy, state.overlay, actions, dispatch]);
  return (
    <div className="browser-shell">
      <a className="skip-link" href="#wallet-workspace">Skip to wallet</a>
      <aside className="browser-sidebar" aria-label="Chicory navigation">
        <div className="browser-brand"><Bloom size={36} detail="mark" tone={wallet?.network && wallet.network !== 'mainnet' ? 'test' : 'live'} /><span>chicory</span></div>
        <nav aria-label="Wallet">
          {navigation.map(item => <button key={item.name} type="button"
            aria-current={active === item.name ? 'page' : undefined}
            aria-label={item.label} title={`${item.label} (${modifier}${shortcuts[item.name]})`}
            data-scene={item.name}
            disabled={!ready || choosing || state.busy || !!state.overlay}
            onClick={() => actions.navigate(item.name)}>
            <Glyph name={item.glyph} size={20} color="currentColor" />
            <span className="browser-nav-label">{item.label}</span>
            <kbd aria-hidden="true">{modifier}{shortcuts[item.name]}</kbd>
          </button>)}
        </nav>
        {/* The open wallet's network and whether it is connected; networks change in Settings.
            A relock may leave the session's wallet in memory, so the lock decides what shows. */}
        {phase.kind !== 'locked' && <div className="browser-wallet-identity" title={wallet?.name || 'Wallet'}
          data-wallet={session.walletId || undefined}>
          <span className="browser-network" title={`${wallet?.network || session.activeProfile.network}: ${session.snapshot?.primary.connected ? 'Connected' : 'Connecting'}`}><i data-connected={!!session.snapshot?.primary.connected} /><span>{wallet?.network || session.activeProfile.network}</span></span>
          <span className="browser-device-caption">On this computer</span>
        </div>}
      </aside>
      <main id="wallet-workspace" className="browser-stage" tabIndex={-1}>{children}</main>
    </div>
  );
}
