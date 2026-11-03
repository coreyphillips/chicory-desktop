import { useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { browserViewProps, createTapInput } from './keyboard.ts';

export function useBrowserTap(props: {
  enabled: boolean;
  begin: () => void;
  cancel: () => void;
  activate: () => void;
}) {
  const latest = useRef(props);
  latest.current = props;
  const input = useMemo(() => createTapInput({
    live: () => latest.current.enabled && document.visibilityState !== 'hidden',
    begin: () => latest.current.begin(),
    cancel: () => latest.current.cancel(),
    activate: () => latest.current.activate(),
  }), []);
  useEffect(() => {
    if (!props.enabled) input.cancel();
    return input.cancel;
  }, [props.enabled, input]);
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
    if (down ? input.keyDown(event.nativeEvent) : input.keyUp(event.nativeEvent)) {
      event.preventDefault(); event.stopPropagation();
    }
  };
  return browserViewProps({
    tabIndex: props.enabled ? 0 : -1,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => key(event, true),
    onKeyUp: (event: KeyboardEvent<HTMLElement>) => key(event, false),
    onBlur: () => input.cancel(),
    onClick: (event: MouseEvent<HTMLElement>) => {
      if (event.detail === 0 && !input.suppressClick() && latest.current.enabled)
        latest.current.activate();
    },
  });
}
