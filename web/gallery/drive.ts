/**
 * The gallery's hands. A state past the first step of a flow, such as a
 * review or a result, is reached the way a person reaches it: by pressing
 * the control labelled for it, with the fake wallet answering at once.
 *
 * There is no test renderer on a phone, so a control is found in React's
 * own tree instead: from the Probe at the root of the state, down through
 * each component's committed props, for the first one with the label and
 * the handler asked for, as test-support/query.ts finds one in a suite. A
 * control in a pane out of use has no handler, so it is not found.
 *
 * On a phone a scene takes real time to arrive and a pane to settle, so a
 * step does not reach for its control on a fixed beat. It waits, as a
 * person would, until what the step before it started has finished, the
 * canvas has stopped moving, and its control is there, enabled and in use,
 * and only then acts (`perform`).
 *
 * Every line the gallery writes starts with GALLERY, so a device log can be
 * filtered down to it. A step whose control has not come after WAIT_MS says
 * MISS, and a state that throws says ERROR, each with the state's name.
 */
import { Component } from 'react';
import type { PropsWithChildren, RefObject } from 'react';
import { isTransitioning } from '../chicory/src/motion/idle';
import type { Step } from './shots';

export function report(line: string) {
  console.log(`GALLERY ${line}`);
}

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The least time from one step to the next, as a finger takes. */
export const STEP_MS = 150;

/** How often a step looks again for a control that is not there yet. */
export const POLL_MS = 100;

/**
 * The longest a step waits for its control, and for what the step before it
 * started to finish. Past this the control is taken not to be coming.
 */
export const WAIT_MS = 4000;

/**
 * The root of one state. It catches what the state throws while drawing, so
 * one broken state is reported and the rest still run, and it is where a
 * step starts looking for the control it asks for.
 */
export class Probe extends Component<
  PropsWithChildren<{ name: string }>,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    report(`ERROR ${this.props.name}: ${reason(error)}`);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The parts of a React fiber the search reads. */
interface Fiber {
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  type: unknown;
  stateNode: unknown;
  memoizedProps: unknown;
}

type Props = Record<string, unknown>;
type Handler = (...args: unknown[]) => unknown;

/** A finger's long press on a hold, as the gesture handler reports it. */
export type HoldStep = 'down' | 'complete' | 'up';

const HOLD_CALLBACKS: Record<HoldStep, string> = {
  down: 'onBegin',
  complete: 'onActivate',
  up: 'onFinalize',
};

const propsOf = (fiber: Fiber): Props | null =>
  fiber.memoizedProps !== null && typeof fiber.memoizedProps === 'object'
    ? (fiber.memoizedProps as Props)
    : null;

/**
 * Whether a view keeps what is inside it from a finger and a screen reader,
 * as a pane out of use does, a scene's slot while the panes move, and a
 * step under a lifted code.
 */
const shuts = (props: Props | null) =>
  !!props &&
  (props.pointerEvents === 'none' ||
    props.accessibilityElementsHidden === true ||
    props.importantForAccessibility === 'no-hide-descendants');

/**
 * The first fiber from `start`, its siblings and all below, in tree order.
 * `test` is also told whether a view above the fiber, below `start`, shuts
 * it off (`shuts`).
 */
function first(
  start: Fiber | null,
  test: (fiber: Fiber, shut: boolean) => boolean,
) {
  const stack: [Fiber, boolean][] = start ? [[start, false]] : [];
  while (stack.length) {
    const [fiber, shut] = stack.pop() as [Fiber, boolean];
    if (test(fiber, shut)) return fiber;
    if (fiber.sibling) stack.push([fiber.sibling, shut]);
    if (fiber.child) stack.push([fiber.child, shut || shuts(propsOf(fiber))]);
  }
  return null;
}

/** The parts of React's root the search reads. */
interface Root {
  current?: Fiber;
  /** The work scheduled on the tree and not yet committed, as lanes. */
  pendingLanes?: number;
}

/** The React root the probe is drawn under. */
function rootOf(instance: Probe): Root | null {
  let top =
    (instance as unknown as { _reactInternals?: Fiber })._reactInternals ??
    null;
  while (top?.return) top = top.return;
  return (top?.stateNode as Root | null) ?? null;
}

/**
 * The probe as it stands now. A class instance keeps a fiber, but not
 * always the committed one, so the search climbs to the root and comes back
 * down the committed tree to the fiber that holds this instance.
 */
function committed(instance: Probe): Fiber | null {
  const root = rootOf(instance)?.current;
  return root ? first(root, fiber => fiber.stateNode === instance) : null;
}

/**
 * Whether React has work scheduled that it has not drawn yet, such as the
 * render a step's press asked for: until it has, the next step would reach
 * into the tree as it was before that press.
 */
const drawing = (instance: Probe) => !!rootOf(instance)?.pendingLanes;

/**
 * Why a control that is there cannot be used yet, or null when it can: it
 * is disabled, or something above it shuts it off.
 */
function unready(props: Props, shut: boolean): string | null {
  if (shut) return 'out of use';
  const state = props.accessibilityState as { disabled?: boolean } | undefined;
  const disabled =
    props.disabled === true ||
    state?.disabled === true ||
    props.editable === false ||
    props.enabled === false;
  return disabled ? 'disabled' : null;
}

/** Where a whisper is asked for, as a finger on the middle of the screen. */
const ANCHOR = { x: 160, y: 320, width: 24, height: 24 };

/** What a screen reader sends when it activates an element. */
const ACTIVATE = { nativeEvent: { actionName: 'activate' } };

export interface Drive {
  /** Taps the control labelled `label`. */
  press: (label: string) => void;
  /** Commits the hold labelled `label`, as a screen reader does. */
  activate: (label: string) => void;
  /** Types `text` into the field labelled `label`. */
  type: (label: string, text: string) => void;
  /** Calls `handler` of the control labelled `label` with `args`. */
  fire: (label: string, handler: string, ...args: unknown[]) => void;
  /**
   * Moves the hold labelled `label` through `step` of a finger's long press:
   * down on it, held until it completes, or lifted.
   */
  hold: (label: string, step: HoldStep) => void;
  /** Calls the first `handler` anywhere in the state with `args`. */
  call: (handler: string, ...args: unknown[]) => void;
  /** Shows the whisper labelled `label`, as a long press does. */
  whisper: (label: string) => void;
}

/** What a step reached for: the handler to call, or why there is none. */
interface Reach {
  handler: Handler | null;
  /** Why a control that is there cannot be used yet, if one is. */
  why: string;
}

/**
 * The gallery's hands for the state named `name`, drawn under `probe`.
 * `attempt` runs a step once: a step reaches for one control, and when that
 * control is not there to use yet it does nothing and is tried again later.
 */
interface Hands {
  /**
   * Runs `step` once. True once it has acted, or, when `last`, once it has
   * said MISS for the control it could not find. Unless `last`, a step
   * waits while the state is not drawn yet, while what the one before it
   * started is still running or still to be drawn, and while the canvas
   * moves.
   */
  attempt: (step: Step, last: boolean) => boolean;
}

function driver(probe: RefObject<Probe | null>, name: string): Hands {
  // Whether this attempt says MISS, and whether its step found nothing.
  let final = false;
  let missed = false;
  // Whether what the last step started, such as a review, has finished.
  let settled = true;

  /** This state's probe, once it is drawn: not the one before it. */
  const here = () => {
    const instance = probe.current;
    return instance && instance.props.name === name ? instance : null;
  };

  function find(
    test: (props: Props, fiber: Fiber, shut: boolean) => boolean,
  ): Props | null {
    const instance = here();
    const root = instance ? committed(instance) : null;
    const found = first(root?.child ?? null, (fiber, shut) => {
      const props = propsOf(fiber);
      return !!props && test(props, fiber, shut);
    });
    return found ? propsOf(found) : null;
  }

  /**
   * Keeps the steps after this one waiting while `result`, when it is a
   * promise, still runs: a handler's work, or a step's own wait.
   */
  function follow(result: unknown) {
    const promised = result as PromiseLike<unknown> | undefined;
    if (typeof promised?.then !== 'function') return;
    settled = false;
    promised.then(
      () => {
        settled = true;
      },
      error => {
        settled = true;
        report(`ERROR ${name}: ${reason(error)}`);
      },
    );
  }

  function invoke(what: string, { handler, why }: Reach, args: unknown[]) {
    if (!handler) {
      missed = true;
      if (final) report(`MISS ${name}: ${what}${why ? `, ${why}` : ''}`);
      return;
    }
    try {
      follow(handler(...args));
    } catch (error) {
      report(`ERROR ${name}: ${reason(error)}`);
    }
  }

  /**
   * The handler `pick` takes from the first component that passes `test`
   * and, unless `anywhere`, is there to use (`unready`). When one is there
   * but not yet usable, says why.
   */
  function reach(
    pick: (props: Props) => unknown,
    test: (props: Props, fiber: Fiber) => boolean,
    anywhere = false,
  ): Reach {
    let why = '';
    let handler = null as Handler | null;
    find((props, fiber, shut) => {
      const found = pick(props);
      if (typeof found !== 'function' || !test(props, fiber)) return false;
      const not = anywhere ? null : unready(props, shut);
      if (not) {
        why = why || not;
        return false;
      }
      handler = found as Handler;
      return true;
    });
    return handler ? { handler, why: '' } : { handler: null, why };
  }

  const named = (handler: string) => (props: Props) => props[handler];

  const fire = (label: string, handler: string, ...args: unknown[]) =>
    invoke(
      `${handler} "${label}"`,
      reach(named(handler), props => props.accessibilityLabel === label),
      args,
    );

  /**
   * A hold is a long press the gesture handler times, with no handler on
   * the control itself, so the step goes to the innermost long press around
   * the control labelled `label`, as the handler would report it, once the
   * gesture is enabled.
   */
  function holdOf(label: string, step: HoldStep): Reach {
    const instance = here();
    const root = instance ? committed(instance) : null;
    const labelled = (fiber: Fiber) =>
      !!first(
        fiber.child,
        inner => propsOf(inner)?.accessibilityLabel === label,
      );
    let innermost: Reach = { handler: null, why: '' };
    first(root?.child ?? null, (fiber, shut) => {
      const config = (propsOf(fiber)?.gesture as { config?: Props } | undefined)
        ?.config;
      const callback = config?.[HOLD_CALLBACKS[step]];
      if (
        typeof config?.minDurationMs === 'number' &&
        typeof callback === 'function' &&
        labelled(fiber)
      ) {
        const why = unready(config, shut);
        innermost = why
          ? { handler: null, why }
          : { handler: callback as Handler, why: '' };
      }
      return false;
    });
    return innermost;
  }

  const drive: Drive = {
    press: label => fire(label, 'onPress'),
    activate: label =>
      invoke(
        `activate "${label}"`,
        reach(
          named('onAccessibilityAction'),
          // react-native-web keeps the action on the View component, not
          // on the DOM element it renders, so any fiber with the label counts.
          props => props.accessibilityLabel === label,
        ),
        [ACTIVATE],
      ),
    type: (label, text) => fire(label, 'onChangeText', text),
    fire,
    hold: (label, step) =>
      invoke(`hold ${step} "${label}"`, holdOf(label, step), [
        step === 'up' ? { canceled: false } : {},
      ]),
    // A handler called directly, as the hero's toggles are, is reached
    // wherever it is: a person would have used another control for it.
    call: (handler, ...args) =>
      invoke(
        handler,
        reach(named(handler), () => true, true),
        args,
      ),
    // A whisper is a long press the gallery has no finger for, so it asks
    // the whisper's provider directly, as the press would.
    whisper: label =>
      invoke(
        `whisper "${label}"`,
        reach(
          props => (props.whispers as { show?: unknown } | undefined)?.show,
          props => props.label === label,
        ),
        [label, ANCHOR, {}],
      ),
  };

  return {
    attempt: (step, last) => {
      const instance = here();
      final = last || instance?.state.failed === true;
      const waiting =
        !instance || !settled || drawing(instance) || isTransitioning();
      if (!final && waiting) return false;
      missed = false;
      follow(step(drive));
      return !missed || final;
    },
  };
}

/**
 * The last step of every state, which reaches for nothing: it waits, as a
 * step does, until the state is drawn, what the steps before it started has
 * finished and been drawn, and the canvas is still.
 */
const reached: Step = () => {};

/**
 * Brings the state named `name`, drawn under `probe`, about by `steps`, one
 * after another, then, once it has been reached, holds it for `hold` and
 * calls `done`. Each step starts at least STEP_MS after the one before it
 * and waits, up to WAIT_MS, for its control (`Hands.attempt`). Returns a
 * cancel, for a state that goes first.
 */
export function perform(
  probe: RefObject<Probe | null>,
  name: string,
  steps: Step[],
  hold: number,
  done: () => void,
): () => void {
  const { attempt } = driver(probe, name);
  const all = [...steps, reached];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gone = false;
  const after = (ms: number, then: () => void) => {
    timer = setTimeout(() => {
      if (!gone) then();
    }, ms);
  };
  function run(at: number) {
    const since = Date.now();
    const tryStep = () => {
      if (!attempt(all[at], Date.now() - since >= WAIT_MS)) {
        after(POLL_MS, tryStep);
      } else if (at + 1 < all.length) {
        after(STEP_MS, () => run(at + 1));
      } else {
        after(hold, done);
      }
    };
    tryStep();
  }
  after(STEP_MS, () => run(0));
  return () => {
    gone = true;
    clearTimeout(timer);
  };
}
