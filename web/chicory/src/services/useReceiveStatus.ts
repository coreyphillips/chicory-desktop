import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { ReceiveRequest, ReceiveStatus } from '@beignet/wallet-core';
import type { WalletAdapter } from './wallet';

/** Consecutive failed reads before the sheet mentions it. */
const FAILURE_LIMIT = 3;

function sameStatus(a: ReceiveStatus, b: ReceiveStatus) {
  return (
    a.phase === b.phase &&
    a.receivedSats === b.receivedSats &&
    a.confirmedSats === b.confirmedSats &&
    a.pendingSats === b.pendingSats &&
    a.method === b.method &&
    a.txid === b.txid &&
    a.activityId === b.activityId &&
    a.txids.length === b.txids.length &&
    a.txids.every((id, i) => id === b.txids[i])
  );
}

// Only the displayed request is polled. A late response cannot update another
// request or wallet, and backgrounding never starts another network read.
export function useReceiveStatus(
  client: WalletAdapter,
  request: ReceiveRequest | null,
  onReceipt: () => void,
) {
  const callback = useRef(onReceipt);
  callback.current = onReceipt;
  const [result, setResult] = useState<{
    request: ReceiveRequest;
    client: WalletAdapter;
    status?: ReceiveStatus;
    error?: string;
    ambiguous?: boolean;
  } | null>(null);
  useEffect(() => {
    if (!request) return;
    let stopped = false;
    let inFlight = false;
    let completed = false;
    let detected = false;
    let failures = 0;
    async function run() {
      if (
        stopped ||
        inFlight ||
        completed ||
        AppState.currentState === 'background' ||
        AppState.currentState === 'inactive'
      )
        return;
      inFlight = true;
      try {
        const status = await client.getReceiveStatus(request!);
        if (stopped) return;
        failures = 0;
        // Keep the same object while nothing observable changed, so a poll
        // that learns nothing new does not re-render the receive sheet.
        setResult(previous =>
          previous &&
          previous.request === request &&
          previous.client === client &&
          !previous.error &&
          previous.status &&
          sameStatus(previous.status, status)
            ? previous
            : { request: request!, client, status },
        );
        if (status.phase === 'completed') {
          completed = true;
          callback.current();
        } else if (!detected && status.phase !== 'waiting') {
          detected = true;
          callback.current();
        }
      } catch (e) {
        const ambiguous =
          (e as { code?: string })?.code === 'AMBIGUOUS_RECEIVE_ADDRESS';
        failures += 1;
        // A single missed read is not news. The last observation stays on
        // screen and the next tick is two seconds away.
        if (stopped || (!ambiguous && failures < FAILURE_LIMIT)) return;
        setResult(previous => ({
            request: request!,
            client,
            ...(previous?.request === request && previous.client === client
              ? {
                  status:
                    ambiguous && previous.status?.method === 'bitcoin'
                      ? undefined
                      : previous.status,
                }
              : {}),
            ambiguous,
            error: ambiguous
              ? 'This address was reused. Bitcoin payments cannot be matched to this request.'
              : 'Payment status unavailable. Still checking.',
          }));
      } finally {
        inFlight = false;
      }
    }
    run();
    const timer = setInterval(run, 2000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') run();
    });
    return () => {
      stopped = true;
      clearInterval(timer);
      subscription.remove();
    };
  }, [client, request]);
  return result?.request === request && result.client === client
    ? result
    : null;
}
