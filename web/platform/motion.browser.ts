import { isCustomLayoutConfig, runMotion } from './motion.ts';
import type { MotionController, MotionDescription, MotionStyle } from './motion.ts';

type MotionElement = HTMLElement & {
  dummyClone?: MotionElement;
  isDummy?: boolean;
  removedAfterAnimation?: boolean;
};
type Rect = { top: number; left: number; width: number; height: number };
type Snapshot = Rect & { scrollOffsets: { scrollTopOffset: number; scrollLeftOffset: number } };
type Snapshots = WeakMap<HTMLElement, Snapshot>;
type Props = { entering?: unknown; exiting?: unknown; layout?: unknown };
const ENTERING = 1;
const EXITING = 2;
const active = new WeakMap<HTMLElement, MotionController>();
/** What a LayoutAnimationConfig let go of with its exits skipped. */
const skipping = new WeakSet<object>();
const UNITLESS = new Set(['opacity', 'zIndex', 'fontWeight', 'flex', 'flexGrow', 'flexShrink', 'order']);

function rectOf(element: HTMLElement): Rect {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}
function measurements(element: HTMLElement, before?: Rect): Record<string, number> {
  const after = rectOf(element);
  const current = before ?? after;
  const canvas = element.closest('[data-chicory-canvas]') ?? element.closest('.wallet-frame');
  const windowRect = canvas?.getBoundingClientRect();
  const parent = (element.offsetParent ?? element.parentElement) as HTMLElement | null;
  const parentRect = parent?.getBoundingClientRect();
  const left = parentRect?.left ?? 0;
  const top = parentRect?.top ?? 0;
  return {
    currentOriginX: current.left - left, currentOriginY: current.top - top,
    currentGlobalOriginX: current.left, currentGlobalOriginY: current.top,
    currentWidth: current.width, currentHeight: current.height,
    targetOriginX: after.left - left, targetOriginY: after.top - top,
    targetGlobalOriginX: after.left, targetGlobalOriginY: after.top,
    targetWidth: after.width, targetHeight: after.height,
    windowWidth: windowRect?.width ?? window.innerWidth,
    windowHeight: windowRect?.height ?? window.innerHeight,
  };
}
function transformCss(transform: unknown): string {
  if (!Array.isArray(transform)) return String(transform ?? '');
  return transform.flatMap(item => Object.entries(item).map(([key, value]) => {
    const units = /^(translate|perspective)/.test(key) && typeof value === 'number' ? 'px' : '';
    if (key === 'matrix' && Array.isArray(value)) return `${value.length === 16 ? 'matrix3d' : 'matrix'}(${value.join(',')})`;
    return `${key}(${String(value)}${units})`;
  })).join(' ');
}
function baseStyle(element: HTMLElement, values: Record<string, number>): MotionStyle {
  const computed = getComputedStyle(element);
  return {
    opacity: Number(computed.opacity), width: values.targetWidth, height: values.targetHeight,
    originX: values.targetOriginX, originY: values.targetOriginY,
    borderRadius: parseFloat(computed.borderRadius) || 0,
    backgroundColor: computed.backgroundColor,
  };
}
function renderer(element: HTMLElement, values: Record<string, number>) {
  const previous = new Map<string, string>();
  const written = new Map<string, string>();
  return {
    write(style: MotionStyle) {
      const transforms = Array.isArray(style.transform) ? [...style.transform] : [];
      // originX/Y are native layout coordinates. Translate the existing flow
      // box instead of removing it from the browser's flex/grid layout.
      if (typeof style.originX === 'number') transforms.unshift({ translateX: style.originX - values.targetOriginX });
      if (typeof style.originY === 'number') transforms.unshift({ translateY: style.originY - values.targetOriginY });
      const next = { ...style };
      delete next.originX; delete next.originY;
      if (transforms.length) next.transform = transforms;
      for (const [key, value] of Object.entries(next)) {
        if (value === undefined || value === null) continue;
        if (!previous.has(key)) previous.set(key, (element.style as unknown as Record<string, string>)[key] ?? '');
        const css = key === 'transform' ? transformCss(value) :
          typeof value === 'number' && !UNITLESS.has(key) ? `${value}px` : String(value);
        (element.style as unknown as Record<string, string>)[key] = css;
        written.set(key, (element.style as unknown as Record<string, string>)[key]);
      }
      element.style.visibility = 'initial';
    },
    restore() {
      // A shared-value mapper or React update may already own a newer style.
      // Restore only values which this layout animation still owns.
      for (const [key, value] of previous) {
        if ((element.style as unknown as Record<string, string>)[key] === written.get(key))
          (element.style as unknown as Record<string, string>)[key] = value;
      }
    },
  };
}
function rememberScroll(root: HTMLElement): Map<Element, [number, number]> {
  return new Map([root, ...Array.from(root.querySelectorAll('*'))].map(item => [item, [item.scrollTop, item.scrollLeft]]));
}
function restoreScroll(positions: Map<Element, [number, number]>) {
  for (const [item, [top, left]] of positions) { item.scrollTop = top; item.scrollLeft = left; }
}

/** Retain exiting DOM in the same dummy contract Reanimated's observer uses. */
function exitingElement(element: MotionElement, snapshots?: Snapshots): { element: MotionElement; cleanup: () => void } {
  const parent = (element.offsetParent ?? element.parentElement) as HTMLElement | null;
  const rect = rectOf(element);
  const clone = element.cloneNode(false) as MotionElement;
  const scroll = rememberScroll(element);
  const visibility = element.style.visibility;
  clone.isDummy = true;
  clone.removeAttribute('id');
  clone.setAttribute('aria-hidden', 'true');
  clone.setAttribute('inert', '');
  clone.setAttribute('data-chicory-motion-exit', 'true');
  clone.style.pointerEvents = 'none';
  clone.style.animation = 'none';
  // Native CSS entrances restart when their DOM is reparented. Their final
  // pose remains in the exit clone, matching Reanimated's own exit handling.
  for (const child of [element, ...Array.from(element.querySelectorAll<HTMLElement>('*'))]) {
    if (!child.style?.animationName?.startsWith('REA-ENTERING-')) continue;
    child.style.animationName = '';
    child.style.animationDuration = '';
    child.style.animationDelay = '';
    child.style.animationFillMode = '';
  }
  element.style.visibility = 'hidden';
  element.dummyClone = clone;
  while (element.firstChild) clone.appendChild(element.firstChild);
  parent?.appendChild(clone);
  const parentRect = parent?.getBoundingClientRect();
  const parentStyle = parent ? getComputedStyle(parent) : null;
  Object.assign(clone.style, {
    position: 'absolute', margin: '0px',
    left: `${rect.left - (parentRect?.left ?? 0) - (parseFloat(parentStyle?.borderLeftWidth ?? '0') || 0) + (parent?.scrollLeft ?? 0)}px`,
    top: `${rect.top - (parentRect?.top ?? 0) - (parseFloat(parentStyle?.borderTopWidth ?? '0') || 0) + (parent?.scrollTop ?? 0)}px`,
    width: `${rect.width}px`, height: `${rect.height}px`,
  });
  restoreScroll(scroll);
  // The native observer uses this snapshot when a departing ancestor would
  // otherwise remove a still-animating child from the document.
  snapshots?.set(clone, { ...rect, scrollOffsets: { scrollTopOffset: 0, scrollLeftOffset: 0 } });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (element.dummyClone === clone) {
      while (clone.firstChild) element.appendChild(clone.firstChild);
      delete element.dummyClone;
      element.style.visibility = visibility;
    }
    clone.removedAfterAnimation = true;
    clone.remove();
  };
  // Reanimated's mutation observer chains this handler if an ancestor leaves.
  clone.onanimationend = cleanup;
  return { element: clone, cleanup };
}

function animate(
  config: (values: Record<string, number>) => MotionDescription,
  source: MotionElement,
  type: number,
  before?: Rect,
  snapshots?: Snapshots,
) {
  const previous = active.get(source);
  previous?.cancel();
  const values = measurements(source, before);
  const description = config(values);
  const exit = type === EXITING ? exitingElement(source, snapshots) : null;
  const target = exit?.element ?? source;
  const styles = renderer(target, values);
  let controller: MotionController | undefined;
  controller = runMotion(description, styles.write, {
    now: () => performance.now(),
    request: callback => requestAnimationFrame(now => {
      // Unmounting an entering-only view must cancel its callbacks. Exits can
      // survive ancestor removal through the native observer's dummy protocol.
      if (!target.isConnected || (exit && source.dummyClone !== target)) {
        controller?.cancel();
        return;
      }
      callback(now);
    }),
    cancel: id => cancelAnimationFrame(id),
  }, {
    base: baseStyle(target, values),
    previous,
    done: finished => {
      if (controller && active.get(source) === controller) active.delete(source);
      if (exit) {
        // Notify the native observer's possible ancestor-retention handler.
        target.dispatchEvent(new Event('animationend'));
        exit.cleanup();
      } else styles.restore();
      source.dispatchEvent(new CustomEvent('chicory-motion-end', { detail: { finished, type } }));
    },
  });
  active.set(source, controller);
}

/**
 * A view's box, in window points, where layout puts it: where it will rest
 * once everything moving it is over. Its box on screen can read still and be
 * wrong. An entrance holds its pose while it waits out its delay, and a layout
 * transition sets out slowly from where the view was, so two readings agree on
 * a place it only starts from. Offsets know nothing of transforms, so nothing
 * can hold them back.
 */
export function restingRect(element: Element): { left: number; top: number; width: number; height: number } {
  const view = element as HTMLElement;
  let left = 0;
  let top = 0;
  for (let at: HTMLElement | null = view; at;) {
    left += at.offsetLeft;
    top += at.offsetTop;
    const parent = at.offsetParent as HTMLElement | null;
    if (parent) { left += parent.clientLeft; top += parent.clientTop; }
    at = parent;
  }
  for (let at = view.parentElement; at; at = at.parentElement) {
    left -= at.scrollLeft;
    top -= at.scrollTop;
  }
  return { left, top, width: view.offsetWidth, height: view.offsetHeight };
}

/**
 * Reanimated's browser build ignores `skipExiting`, so exits play anyway, with
 * nothing left around them. A config unmounts before its children, so it marks
 * its view here and they find that as they go.
 */
export function skipExits(instance: unknown, skip?: boolean) {
  const view = instance as { _componentDOMRef?: object } | null | undefined;
  const element = view?._componentDOMRef ?? view;
  if (skip && element) skipping.add(element);
}
function exitSkipped(element: HTMLElement) {
  for (let at: HTMLElement | null = element; at; at = at.parentElement) if (skipping.has(at)) return true;
  return false;
}

/** Called before Reanimated's CSS-only dispatcher in both dev and builds. */
export function runCustomWebAnimation(props: Props, element: HTMLElement, type: number, snapshots?: Snapshots): boolean {
  if (type !== ENTERING && type !== EXITING) return false;
  if (type === EXITING && exitSkipped(element)) return true;
  const config = type === ENTERING ? props.entering : props.exiting;
  if (!isCustomLayoutConfig(config)) return false;
  animate(config, element, type, undefined, snapshots);
  return true;
}
export function runCustomWebLayout(props: Props, element: HTMLElement, before: Rect): boolean {
  if (!isCustomLayoutConfig(props.layout)) return false;
  const after = rectOf(element);
  if (before.left === after.left && before.top === after.top && before.width === after.width && before.height === after.height) return true;
  animate(props.layout, element, 3, before);
  return true;
}
