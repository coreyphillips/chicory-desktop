import React, { useEffect, useRef, useState } from 'react';
import type { Network } from '@beignet/wallet-core';
import type { FlorestaSettingsBridge, FlorestaState } from '../../../../platform/desktop';
import { Action, Line, Link, Note, Row } from './ui';

function scanStatus(watches: FlorestaState['watches']) {
  if (!watches) return 'Pending';
  if ('unavailable' in watches) return 'Unavailable';
  if (!watches.observedWallets) return 'No active wallet observed';
  return `${watches.confirmedScansCaughtUp} of ${watches.observedWallets} observed wallets caught up`;
}

function historyStatus(state: FlorestaState) {
  const labels = { unknown: 'Completion unconfirmed', pending: 'Pending', verifying: 'Verifying', verified: 'Verified', error: 'Verification failed' };
  const label = labels[state.historicalVerification];
  return state.historicalHeight === null ? label : `${label} (${state.historicalHeight} of ${state.historicalTarget} blocks)`;
}

export function FlorestaQualification({ network, bridge }: { network: Network; bridge: FlorestaSettingsBridge }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FlorestaState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const poll = async () => {
      if (active.current) return;
      const generation = epoch.current;
      try {
        const next = await bridge.status(network);
        if (live && generation === epoch.current) setState(next);
      } catch {
        if (live && generation === epoch.current) setError('Unlock Chicory to view the local node settings.');
      }
    };
    void poll();
    const interval = setInterval(poll, 2000);
    return () => { live = false; clearInterval(interval); };
  }, [open, bridge, network]);
  async function change(op: 'start' | 'stop' | 'folder' | 'remove') {
    if (active.current) return;
    active.current = true;
    epoch.current++;
    setBusy(true);
    setError('');
    try { setState(await bridge[op](network)); }
    catch { setError('Chicory could not change the local node settings. Check the profile lock and storage folder.'); }
    finally { active.current = false; setBusy(false); }
  }
  const phases = { stopped: 'Stopped', starting: 'Starting', running: 'Running', restarting: 'Restarting', failed: 'Failed' };
  return <>
    <Row glyph="flask" label="Experimental Floresta node" expanded={open} onPress={() => setOpen(value => !value)} />
    {open ? <>
      <Note announce={false}>{`Your ${network} wallet and Lightning channels use the selected Electrum server. Floresta syncs separately with Bitcoin peers and scans public wallet and channel watches.`}</Note>
      {state ? <>
        <Line label="Local node" value={phases[state.phase]} />
        <Line label="Node storage" value={state.storage} />
        {!state.volumeAvailable ? <Note tone="error">Reconnect the selected volume to access its local node data.</Note> : null}
        {state.height !== null ? <>
          <Line label="Header height" value={String(state.height)} />
          <Line label="Validated height" value={String(state.validatedHeight ?? 'Unavailable')} />
          <Line label="Current tip" value={state.tipSynced ? 'Caught up to known tip' : 'Syncing'} />
        </> : null}
        <Line label="Confirmed watch scans" value={scanStatus(state.watches)} />
        <Line label="Historical verification" value={historyStatus(state)} />
        {state.error ? <Note tone="error">{state.error}</Note> : null}
        {!state.requested && !state.storageUsed && state.customStorage ? <Link label="Choose storage folder" onPress={() => change('folder')} disabled={busy} /> : null}
        {!state.requested && state.storageUsed ? state.removalAvailable
          ? <Link label="Remove local node data" onPress={() => change('remove')} disabled={busy} />
          : <Note>Automatic node data removal requires a local macOS APFS volume. On this platform, close every node before manually removing its generated data from the selected location.</Note> : null}
        {!state.requested || state.phase === 'failed' ? <Action label={state.requested ? 'Retry local node' : 'Start local node'}
          onPress={() => change('start')} disabled={busy} /> : null}
        {state.requested ? <Action label="Stop and disable local node" tone="quiet" onPress={() => change('stop')} disabled={busy} /> : null}
      </> : null}
      {error ? <Note tone="error">{error}</Note> : null}
    </> : null}
  </>;
}
