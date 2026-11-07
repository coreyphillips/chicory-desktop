import React, { useEffect, useRef, useState } from 'react';
import type { Network } from '@beignet/wallet-core';
import { florestaTipProgress, type FlorestaSettingsBridge, type FlorestaState } from '../../../../platform/desktop';
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
    let polling = false;
    const poll = async () => {
      if (active.current || polling) return;
      polling = true;
      const generation = epoch.current;
      try {
        const next = await bridge.status(network);
        if (live && generation === epoch.current) { setState(next); setError(''); }
      } catch {
        if (live && generation === epoch.current) setError('Unlock Chicory to view the local node settings.');
      } finally { polling = false; }
    };
    void poll();
    const interval = setInterval(poll, 2000);
    return () => { live = false; clearInterval(interval); };
  }, [open, bridge, network]);
  async function change(op: 'start' | 'stop' | 'folder' | 'remove' | 'allowCheckpoint' | 'requireHistory') {
    if (active.current) return;
    active.current = true;
    epoch.current++;
    setBusy(true);
    setError('');
    try { setState(await bridge[op](network)); }
    catch { setError('Chicory could not change the local node settings. Check the profile lock and storage folder.'); }
    finally { active.current = false; setBusy(false); }
  }
  const phases = { stopped: 'Stopped', starting: 'Starting', running: 'Running', 'waiting-for-tip': 'Waiting for fresh chain data', restarting: 'Restarting', failed: 'Failed' };
  const tip = state && florestaTipProgress(network, state);
  return <>
    <Row glyph="flask" label="Experimental Floresta node" expanded={open} onPress={() => setOpen(value => !value)} />
    {open ? <>
      <Note announce={false}>{`Your ${network} wallet and Lightning channels use the selected Electrum server. Floresta syncs separately with Bitcoin peers and scans public wallet and channel watches.`}</Note>
      {state ? <>
        <Line label="Local node" value={phases[state.phase]} />
        <Line label="Node storage" value={state.storage} />
        {state.storageNeedsRebuild ? <Note>Existing node data needs a fresh sync with this build. Remove the generated node data to start again.</Note> : null}
        {state.freeBytes !== null && <Line label="Available disk space" value={`${(state.freeBytes / 2 ** 30).toLocaleString(undefined, { maximumFractionDigits: 1 })} GiB`} />}
        {!state.volumeAvailable ? <Note tone="error">Reconnect the selected volume to access its local node data.</Note> : null}
        {state.height !== null ? <>
          <Line label="Header height" value={String(state.height)} />
          <Line label="Validated height" value={String(state.validatedHeight ?? 'Unavailable')} />
          {tip && <Line label="Current tip" value={tip.label} />}
          {tip && tip.remaining !== null ? <Line label="Known blocks still to validate" value={tip.remaining.toLocaleString()} /> : null}
        </> : null}
        {network === 'mainnet' ? <>
          <Line label="Checkpoint quick start" value={state.checkpointQuickStart ? 'Use checkpoint while verifying history' : 'Wait for full verification'} />
          {state.checkpointHold ? <Note tone="error">{state.checkpointHold === 'previous-accumulator-mismatch'
            ? 'Earlier verification disagreed with the checkpoint. Local reads require successful independent verification.'
            : 'The previous verification was interrupted or unavailable. Local reads require independent verification.'}</Note> : null}
          {state.checkpointAccepted ? <Note>The node is following current blocks using the checkpoint at 939,969. Earlier history is still being verified.</Note> : null}
          <Link label={state.checkpointQuickStart ? 'Require full verification before use' : 'Use checkpoint quick start'}
            onPress={() => change(state.checkpointQuickStart ? 'requireHistory' : 'allowCheckpoint')} disabled={busy} />
        </> : null}
        <Line label="Confirmed watch scans" value={scanStatus(state.watches)} />
        <Line label="Historical verification" value={historyStatus(state)} />
        {state.error ? <Note tone="error">{state.error}</Note> : null}
        {!state.requested && !state.storageUsed && state.customStorage ? <Link label="Choose storage folder" onPress={() => change('folder')} disabled={busy} /> : null}
        {!state.requested && state.storageUsed ? state.canConfirmRemoved
          ? <Link label="Confirm local node data was removed" onPress={() => change('remove')} disabled={busy} />
          : state.removalAvailable
          ? <Link label="Remove local node data" onPress={() => change('remove')} disabled={busy} />
          : <Note>{`Close every node, remove the generated directory at ${state.storagePath}, then confirm removal here.`}</Note> : null}
        {!state.requested || state.phase === 'failed' ? <Action label={state.requested ? 'Retry local node' : 'Start local node'}
          onPress={() => change('start')} disabled={busy || state.storageNeedsRebuild} /> : null}
        {state.requested ? <Action label="Stop and disable local node" tone="quiet" onPress={() => change('stop')} disabled={busy} /> : null}
      </> : null}
      {error ? <Note tone="error">{error}</Note> : null}
    </> : null}
  </>;
}
