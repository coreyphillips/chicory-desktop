import { flushSync } from 'react-dom';

type Update = () => void;

interface Swapping {
  startViewTransition?: (update: Update) => {
    ready: Promise<unknown>;
    updateCallbackDone: Promise<unknown>;
    finished: Promise<unknown>;
  };
  documentElement?: { dataset: DOMStringMap };
}

let queued: Update[] | null = null;
/** Transitions under way. A newer one skips the last, so both end. */
let running = 0;

/**
 * Runs `update`, which changes the page in a single commit, under a view
 * transition: the browser holds the last frame, the commit happens behind it,
 * and the compositor moves from one to the other, so nothing the commit or the
 * page does can drop a frame of it. `kind` says what moves (style.css): a
 * `scene` taking another's place, or the Activity `column` widening beside
 * Overview. A skipped transition still runs the update, so the worst it can
 * be is a clean cut, and with no such API that is all it is.
 *
 * The callback runs a frame later, so an update that comes in the meantime
 * waits to join it, in order, rather than overtaking it.
 *
 * `data-swapping` on the page names the layers the transition moves
 * (style.css). They are named only while it runs, so at rest nothing carries
 * the stacking context a name brings.
 */
export function swapScene(
  update: Update,
  kind: 'scene' | 'column' = 'scene',
  page: Swapping | undefined = typeof document === 'undefined' ? undefined : document,
  commit: (run: Update) => void = flushSync,
): void {
  if (queued) { queued.push(update); return; }
  if (!page?.startViewTransition) { update(); return; }
  queued = [update];
  const marks = page.documentElement?.dataset;
  if (marks) marks.swapping = kind;
  running += 1;
  const transition = page.startViewTransition(() => {
    const updates = queued ?? [];
    queued = null;
    commit(() => { for (const next of updates) next(); });
  });
  // A skipped transition rejects these and has already done its work. An
  // update that threw has not, and says so.
  transition.ready.catch(() => {});
  transition.finished.catch(() => {}).finally(() => {
    running -= 1;
    if (marks && running === 0) delete marks.swapping;
  });
  transition.updateCallbackDone.catch(cause => { reportError(cause); });
}
