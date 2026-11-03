import { useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { browserViewProps, createHoldInput } from './keyboard.ts';

interface BrowserHoldProps {
  enabled: boolean;
  duration: number;
  begin: () => boolean;
  cancel: () => void;
  commit: () => void;
  accessibleCommit: () => void;
  maxDistance: number;
}

/** Browser events keep native hold visuals, with no second gesture timer. */
export function useBrowserHold(props: BrowserHoldProps) {
  const latest = useRef(props);
  latest.current = props;
  const input = useMemo(() => createHoldInput({
    duration: () => latest.current.duration,
    live: () => latest.current.enabled && document.visibilityState !== 'hidden',
    begin: () => latest.current.begin(),
    cancel: () => latest.current.cancel(),
    commit: () => latest.current.commit(),
    maxDistance: props.maxDistance,
  }), [props.maxDistance]);

  useEffect(() => {
    input.reset();
    return input.cancel;
  }, [input, props.enabled, props.duration]);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function' || typeof document === 'undefined') return;
    const hidden = () => { if (document.visibilityState === 'hidden') input.cancel(); };
    window.addEventListener('blur', input.cancel);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      input.cancel();
      window.removeEventListener('blur', input.cancel);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [input]);

  const key = (event: KeyboardEvent<HTMLElement>, down: boolean) => {
    if (event.target !== event.currentTarget) return;
    if ((down ? input.keyDown(event.nativeEvent) : input.keyUp(event.nativeEvent))) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  return browserViewProps({
    tabIndex: props.enabled ? 0 : -1,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => key(event, true),
    onKeyUp: (event: KeyboardEvent<HTMLElement>) => key(event, false),
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (!props.enabled || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      if (input.pointerDown(event.pointerId, event.clientX, event.clientY))
        event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => input.pointerMove(event.pointerId, event.clientX, event.clientY),
    onPointerUp: (event: PointerEvent<HTMLElement>) => input.pointerUp(event.pointerId),
    onPointerCancel: () => input.cancel(),
    onLostPointerCapture: () => input.cancel(),
    onContextMenu: (event: MouseEvent<HTMLElement>) => event.preventDefault(),
    onBlur: () => input.cancel(),
    onClick: (event: MouseEvent<HTMLElement>) => {
      // Virtual clicks preserve the native screen-reader activation action.
      // Keyboard events handled above cannot turn a short key press into one.
      if (event.detail === 0 && !input.suppressClick() && latest.current.enabled)
        latest.current.accessibleCommit();
      event.preventDefault();
    },
  });
}
