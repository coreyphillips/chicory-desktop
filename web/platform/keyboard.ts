/** Browser input policy shared by the amount controls and hold confirmation. */
export interface BrowserKey {
  key: string;
  repeat?: boolean;
  isComposing?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/** React Native's type declarations describe native events, while its web
 * renderer forwards DOM events. Keep that platform boundary at the JSX edge. */
export function browserViewProps<T extends object>(props: T): Record<string, unknown> {
  return props as Record<string, unknown>;
}

export function unmodifiedKey(event: BrowserKey): boolean {
  return !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey;
}

export function holdKey(event: BrowserKey): 'Enter' | ' ' | null {
  if (!unmodifiedKey(event) || event.shiftKey) return null;
  return event.key === 'Enter' || event.key === ' ' ? event.key : null;
}

export function amountKey(event: BrowserKey): string | 'back' | null {
  if (!unmodifiedKey(event)) return null;
  if (/^[0-9]$/.test(event.key)) return event.key;
  return event.key === 'Backspace' ? 'back' : null;
}

/** Text entry keeps its own browser editing shortcuts and composition events. */
export function editableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown };
  return /^(INPUT|TEXTAREA|SELECT)$/i.test(element.tagName ?? '') ||
    element.isContentEditable === true ||
    !!element.closest?.('[contenteditable=""], [contenteditable="true"], [role="textbox"]');
}

export interface HoldScheduler {
  now: () => number;
  set: (callback: () => void, milliseconds: number) => unknown;
  clear: (timer: unknown) => void;
}
export interface HoldInputOptions {
  duration: () => number;
  live: () => boolean;
  begin: () => boolean;
  cancel: () => void;
  commit: () => void;
  maxDistance?: number;
}
type Hold = { kind: 'key'; key: string; at: number } |
  { kind: 'pointer'; id: number; x: number; y: number; at: number };
const clock: HoldScheduler = {
  now: () => performance.now(),
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * One owner times a browser hold. A release, cancellation or replacement makes
 * every queued callback inert, including a timer already in the event queue.
 */
export function createHoldInput(options: HoldInputOptions, scheduler: HoldScheduler = clock) {
  let active: Hold | null = null;
  let timer: unknown;
  let sealed = false;
  let clickAfter = 0;
  let serial = 0;
  const stopTimer = () => {
    if (timer !== undefined) scheduler.clear(timer);
    timer = undefined;
  };
  const cancel = () => {
    serial++;
    stopTimer();
    if (active && !sealed) options.cancel();
    active = null;
  };
  const start = (next: Hold): boolean => {
    if (active || sealed || !options.live() || !options.begin()) return false;
    active = next;
    const token = ++serial;
    const required = options.duration();
    const complete = () => {
      if (token !== serial || !active || sealed) return;
      if (!options.live()) { cancel(); return; }
      const left = required - (scheduler.now() - next.at);
      if (left > 0) { timer = scheduler.set(complete, left); return; }
      stopTimer();
      sealed = true;
      options.commit();
    };
    timer = scheduler.set(complete, required);
    return true;
  };
  return {
    keyDown(event: BrowserKey): boolean {
      const key = holdKey(event);
      if (!key) {
        if (active?.kind === 'key' && (!unmodifiedKey(event) || event.shiftKey)) cancel();
        return false;
      }
      clickAfter = scheduler.now() + 1000;
      if (!event.repeat) start({ kind: 'key', key, at: scheduler.now() });
      return true;
    },
    keyUp(event: BrowserKey): boolean {
      // Modifier state may change between keydown and keyup. Always release
      // the key that owns this hold, even after Shift or a shortcut was used.
      if (active?.kind !== 'key' || event.key !== active.key) return holdKey(event) !== null;
      clickAfter = scheduler.now() + 100;
      cancel();
      return true;
    },
    pointerDown(id: number, x: number, y: number): boolean {
      return start({ kind: 'pointer', id, x, y, at: scheduler.now() });
    },
    pointerMove(id: number, x: number, y: number) {
      if (active?.kind !== 'pointer' || active.id !== id) return;
      if (Math.hypot(x - active.x, y - active.y) > (options.maxDistance ?? 44)) cancel();
    },
    pointerUp(id: number) {
      if (active?.kind === 'pointer' && active.id === id) cancel();
    },
    cancel,
    reset() { cancel(); sealed = false; },
    suppressClick: () => active?.kind === 'key' || scheduler.now() < clickAfter,
  };
}

/** Standard button keyboard behavior, without browser-generated duplicate taps. */
export function createTapInput(options: {
  live: () => boolean;
  begin: () => void;
  cancel: () => void;
  activate: () => void;
}, now: () => number = () => performance.now()) {
  let key: string | null = null;
  let clickAfter = 0;
  const cancel = () => {
    if (key) { key = null; clickAfter = now() + 100; options.cancel(); }
  };
  return {
    keyDown(event: BrowserKey): boolean {
      const next = holdKey(event);
      if (!next) {
        if (!unmodifiedKey(event) || event.shiftKey) cancel();
        return false;
      }
      if (!options.live() || event.repeat || key) return true;
      key = next;
      options.begin();
      if (key === 'Enter') options.activate();
      return true;
    },
    keyUp(event: BrowserKey): boolean {
      if (event.key !== key) return holdKey(event) !== null;
      const activate = key === ' ' && options.live();
      cancel();
      if (activate) options.activate();
      return true;
    },
    cancel,
    suppressClick: () => key !== null || now() < clickAfter,
  };
}
