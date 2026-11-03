import { AppState } from 'react-native';
import { recordDiagnostic } from './diagnosticLog';

/**
 * Where the first minute of a cold start goes, written down once it is over.
 *
 * The wallet page opens on its cached figures and the engine then boots on
 * the same JavaScript thread, so a launch that looks ready can still drop
 * taps and scrolls for seconds while the engine loads, the vault opens, the
 * network map is imported and the primary's gossip is stored. Nothing on
 * screen says which. This report does. From the top of index.js it notes
 * when each step of the boot first happened (`markBoot`, and `markEngine`
 * for the engine's own timings), every time the thread was too busy to run
 * a 50ms timer on time (a stall), what the wallet's SQLite did, how the
 * session's reads went, and the taps a moving pane refused. When the window
 * closes it prints five `CHICORY_PERF` lines, which
 * `adb logcat -s ReactNativeJS:V | grep CHICORY_PERF` reads off a phone, and
 * writes the same five to the diagnostic log under phase `perf`, so they
 * travel in the report Settings > Diagnostics copies. That page lists only
 * the app's own errors, so they never show as one.
 *
 * Every time in the report is in milliseconds since the report started,
 * before the app's own code had loaded.
 *
 * It costs a timer every 50ms and a clock read per SQLite statement for one
 * minute, and nothing after it. Only index.js starts it, so under Jest every
 * hook here does nothing: no suite sees its timers or its lines unless the
 * suite starts it on purpose.
 */

/**
 * How long after a cold start the report watches, and when it is written.
 * This is its one switch: 0 turns it off.
 */
export const PERF_WINDOW_MS = 60000;

/** How often the stall monitor asks to run. */
export const TICK_MS = 50;

/**
 * The least lateness counted as a stall, about where a tap starts to feel
 * ignored. The two above it sort stalls by how they feel: a hitch, and an
 * app that looks frozen.
 */
export const STALL_MS = 100;
export const HITCH_MS = 250;
export const FROZEN_MS = 1000;

/**
 * How long after the canvas first paints the page is judged on its own: the
 * stretch in which someone who can see their wallet starts to use it.
 */
export const AFTER_PAINT_MS = 15000;

/** The longest message the diagnostic log keeps whole (`diagnosticLog`). */
export const ENTRY_LIMIT = 300;

/** How much of a statement the report keeps: its shape, never its values. */
const SQL_SHOWN = 32;

/**
 * A ceiling on the stalls kept. Each is at least STALL_MS long, so a window
 * cannot hold this many; it only bounds a clock that misbehaves.
 */
const STALLS_KEPT = Math.ceil(PERF_WINDOW_MS / TICK_MS);

export interface Mark {
  /** When it first happened. */
  at: number;
  detail?: string;
  /** Reported by the engine (`engine-perf`) rather than by the app. */
  engine?: boolean;
}

export interface Stall {
  /** When the monitor's timer was due and found the thread busy. */
  at: number;
  /** How late the timer ran: at least how long the thread was held. */
  ms: number;
}

export interface SqliteTally {
  statements: number;
  /**
   * Durable commits: each COMMIT, and each write made outside a transaction,
   * which SQLite commits on its own, each with its own sync to disk.
   */
  commits: number;
  /** Of `commits`, the writes that committed alone. */
  alone: number;
  ms: number;
  longestMs: number;
  /** The start of the slowest statement's text, whitespace collapsed. */
  longest: string;
  /** Statements that wrote a row of the network map. */
  gossipWrites: number;
  /** Rows of the network map read back from disk. */
  gossipRows: number;
}

export interface ReadTally {
  count: number;
  /** Reads that began while another was still out. */
  overlapped: number;
  ms: number;
  longestMs: number;
}

export interface BootRecord {
  /** How long the report ran. */
  ran: number;
  /** How much of that the stall monitor watched, with the app in front. */
  watched: number;
  /** In the order each first happened. */
  marks: Map<string, Mark>;
  stalls: Stall[];
  sqlite: SqliteTally;
  reads: ReadTally;
  refusedTaps: number;
}

const emptyRecord = (): BootRecord => ({
  ran: 0,
  watched: 0,
  marks: new Map(),
  stalls: [],
  sqlite: {
    statements: 0,
    commits: 0,
    alone: 0,
    ms: 0,
    longestMs: 0,
    longest: '',
    gossipWrites: 0,
    gossipRows: 0,
  },
  reads: { count: 0, overlapped: 0, ms: 0, longestMs: 0 },
  refusedTaps: 0,
});

let began = 0;
let recording = false;
const record = emptyRecord();
let ticker: ReturnType<typeof setInterval> | null = null;
let due = 0;
let watchingSince = 0;
let ending: ReturnType<typeof setTimeout> | null = null;
let listening: { remove: () => void } | null = null;

/**
 * Starts the report, once per launch. Anything that goes wrong here turns
 * the report off rather than the launch: it is a measurement, never a step
 * the app depends on.
 */
export function startBootPerf(): void {
  if (began || PERF_WINDOW_MS <= 0) return;
  began = Date.now();
  recording = true;
  try {
    listening = AppState.addEventListener('change', watch);
    watch(AppState.currentState);
    ending = setTimeout(finish, PERF_WINDOW_MS);
  } catch {
    stop();
    recording = false;
  }
}

/**
 * Runs the stall monitor while the app is in front. In the background a
 * phone pauses or slows timers, and that gap is not a stall anyone felt.
 * Anything else counts as in front, `unknown` included, which is what iOS
 * says while it is still launching the app.
 */
function watch(state: unknown) {
  if (!recording) return;
  const away = state === 'background' || state === 'inactive';
  if (away && ticker) {
    clearInterval(ticker);
    ticker = null;
    record.watched += Date.now() - watchingSince;
  } else if (!away && !ticker) {
    watchingSince = Date.now();
    due = watchingSince + TICK_MS;
    ticker = setInterval(tick, TICK_MS);
  }
}

/**
 * A timer due every TICK_MS that ran late was held behind other work. Timers
 * the thread could not run while it was held may then run back to back, so
 * each tick is measured from the one before rather than from the schedule,
 * and a stall is counted once.
 */
function tick() {
  const now = Date.now();
  const late = now - due;
  if (late >= STALL_MS && record.stalls.length < STALLS_KEPT)
    record.stalls.push({ at: due - began, ms: late });
  due = now + TICK_MS;
}

function stop() {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
    record.watched += Date.now() - watchingSince;
  }
  if (ending) clearTimeout(ending);
  ending = null;
  listening?.remove();
  listening = null;
}

function finish() {
  if (!recording) return;
  recording = false;
  stop();
  record.ran = Date.now() - began;
  try {
    for (const line of bootReport(record)) {
      console.log(`CHICORY_PERF ${line}`);
      recordDiagnostic({ phase: 'perf', message: fit(line) });
    }
  } catch {
    // A report that cannot be written is simply missing.
  }
}

/** Records when `name` first happened; later ones are the same step again. */
function mark(name: string, detail: string | undefined, engine: boolean) {
  if (!recording || !name || record.marks.has(name)) return;
  record.marks.set(name, {
    at: Date.now() - began,
    ...(detail ? { detail } : {}),
    ...(engine ? { engine } : {}),
  });
}

/** A step of the app's boot, the first time it happens. */
export function markBoot(name: string, detail?: string): void {
  mark(name, detail, false);
}

/**
 * An `engine-perf` event as a mark: its first word names it and the rest is
 * its detail, as in `gossip-synced download 300ms apply 4200ms busy 1900ms
 * slices 230`.
 */
export function markEngine(message: string): void {
  const [name, detail] = engineMark(message);
  mark(name, detail, true);
}

/** The name and detail of an `engine-perf` message. */
export function engineMark(message: string): [string, string | undefined] {
  const text = String(message ?? '').trim();
  const space = text.search(/\s/);
  return space < 0
    ? [text, undefined]
    : [text.slice(0, space), text.slice(space + 1).trim() || undefined];
}

const COMMIT = /^\s*(?:COMMIT|END)\b/i;
const WRITE = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
const READ = /^\s*SELECT\b/i;
const GOSSIP = /\bgossip_(?:channels|nodes)\b/i;

/**
 * One SQLite statement, as the wallet's database ran it: how long it took,
 * how many rows it returned, and whether it ran outside any transaction, in
 * which case a write commits, and syncs, on its own. Only the statement's
 * text is read, never its parameters.
 */
export function noteSqlite(
  sql: string,
  ms: number,
  rows = 0,
  outside = false,
): void {
  if (!recording) return;
  tallySqlite(record.sqlite, sql, ms, rows, outside);
}

/** `noteSqlite`'s arithmetic, on a tally of its own. */
export function tallySqlite(
  tally: SqliteTally,
  sql: string,
  ms: number,
  rows: number,
  outside: boolean,
): void {
  tally.statements += 1;
  tally.ms += ms;
  if (ms > tally.longestMs) {
    tally.longestMs = ms;
    tally.longest = sql.replace(/\s+/g, ' ').trim().slice(0, SQL_SHOWN);
  }
  const write = WRITE.test(sql);
  if (COMMIT.test(sql)) tally.commits += 1;
  else if (write && outside) {
    tally.commits += 1;
    tally.alone += 1;
  }
  if (!sql.includes('gossip_') || !GOSSIP.test(sql)) return;
  if (write) tally.gossipWrites += 1;
  else if (READ.test(sql)) tally.gossipRows += rows;
}

/**
 * One wallet read (`snapshot`), how long it took, and whether another was
 * still out when it began.
 */
export function noteRead(ms: number, overlapped: boolean): void {
  if (!recording) return;
  const reads = record.reads;
  reads.count += 1;
  if (overlapped) reads.overlapped += 1;
  reads.ms += ms;
  reads.longestMs = Math.max(reads.longestMs, ms);
}

/** A tap the stage refused because a pane was still moving. */
export function noteRefusedTap(): void {
  if (recording) record.refusedTaps += 1;
}

export interface StallSummary {
  /** Stalls of at least STALL_MS, HITCH_MS and FROZEN_MS. */
  count: number;
  hitches: number;
  frozen: number;
  longest: Stall | null;
  /** Their lengths, added up. */
  total: number;
}

/**
 * The stalls that reach into `from` to `to`, counted whole: a stall that
 * began before `from` and ran past it was felt after it too.
 */
export function stallSummary(
  stalls: readonly Stall[],
  from = 0,
  to = Infinity,
): StallSummary {
  const summary: StallSummary = {
    count: 0,
    hitches: 0,
    frozen: 0,
    longest: null,
    total: 0,
  };
  for (const stall of stalls) {
    if (stall.at + stall.ms <= from || stall.at >= to) continue;
    summary.count += 1;
    if (stall.ms >= HITCH_MS) summary.hitches += 1;
    if (stall.ms >= FROZEN_MS) summary.frozen += 1;
    summary.total += stall.ms;
    if (!summary.longest || stall.ms > summary.longest.ms)
      summary.longest = stall;
  }
  return summary;
}

/** Seconds, to the nearest whole one. */
const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;

const stallText = (summary: StallSummary) =>
  summary.longest
    ? [
        `${summary.count} over ${STALL_MS}ms`,
        `${summary.hitches} over ${HITCH_MS}ms`,
        `${summary.frozen} over ${seconds(FROZEN_MS)}`,
        `longest ${summary.longest.ms}ms at ${summary.longest.at}`,
        `total ${summary.total}ms`,
      ].join(', ')
    : 'none';

const sqliteText = (sqlite: SqliteTally) =>
  sqlite.statements
    ? [
        `${sqlite.statements} statements ${sqlite.ms}ms`,
        `commits ${sqlite.commits} (${sqlite.alone} alone)`,
        `longest ${sqlite.longestMs}ms "${sqlite.longest}"`,
        `gossip ${sqlite.gossipWrites} writes ${sqlite.gossipRows} rows`,
      ].join(', ')
    : 'none';

const marksText = (marks: [string, Mark][]) =>
  marks.length
    ? marks
        .map(([name, { at, detail }]) =>
          detail ? `${name} ${at} (${detail})` : `${name} ${at}`,
        )
        .join(', ')
    : 'none';

/**
 * Every stall of HITCH_MS or more, in the order they were seen, as `ms at
 * time`: where the thread was held long enough to be felt as a hitch, to
 * place beside the boot's steps. The stall line only counts them.
 */
const hitchText = (stalls: readonly Stall[]) => {
  const hitches = stalls.filter(stall => stall.ms >= HITCH_MS);
  return hitches.length
    ? hitches.map(stall => `${stall.ms}ms at ${stall.at}`).join(', ')
    : 'none';
};

/**
 * The report's five lines, most telling figures first in each:
 *
 * - `boot`: when each of the app's steps first happened, as `name time`,
 *   with a detail in brackets: how long an encrypted open took, or that the
 *   page had nothing cached to open on.
 * - `engine`: the engine's own timings.
 * - `sqlite`: the wallet's SQLite: its statements and their time, its
 *   durable commits and how many of those were writes that committed alone,
 *   the slowest statement, and the network map's writes and the rows read
 *   back. It has a line of its own so a long engine line, cut to fit the
 *   diagnostic log, does not take it along.
 * - `stalls`: the stalls over the whole window, then those in the
 *   AFTER_PAINT_MS after the canvas first painted, then the session's reads
 *   and the taps a moving pane refused.
 * - `hitches`: each stall of HITCH_MS or more, how long it held the thread
 *   and when it was seen.
 */
export function bootReport(source: BootRecord): string[] {
  const marks = [...source.marks];
  const { reads } = source;
  // A window that closes before AFTER_PAINT_MS has passed since the paint
  // looked for less, and the line says how long.
  const painted = source.marks.get('canvas-painted');
  const span = painted
    ? Math.min(AFTER_PAINT_MS, Math.max(0, source.ran - painted.at))
    : 0;
  const afterPaint = painted
    ? `${seconds(span)} after paint ${stallText(
        stallSummary(source.stalls, painted.at, painted.at + span),
      )}`
    : 'no paint';
  return [
    `boot ${marksText(marks.filter(([, step]) => !step.engine))}`,
    `engine ${marksText(marks.filter(([, step]) => step.engine))}`,
    `sqlite ${sqliteText(source.sqlite)}`,
    [
      `stalls ${stallText(stallSummary(source.stalls))}, ` +
        `${seconds(source.watched)} watched`,
      afterPaint,
      `reads ${reads.count} (${reads.overlapped} overlapped) ${reads.ms}ms, ` +
        `longest ${reads.longestMs}ms`,
      `refused taps ${source.refusedTaps}`,
    ].join('; '),
    `hitches ${hitchText(source.stalls)}`,
  ];
}

/**
 * A line as the diagnostic log keeps it: whole when it fits in `limit`, and
 * otherwise cut after its last whole item that leaves room to say so. The
 * printed line keeps everything, and each line leads with what matters most.
 */
export function fit(line: string, limit = ENTRY_LIMIT): string {
  if (line.length <= limit) return line;
  const more = ' …';
  const room = line.slice(0, limit - more.length);
  const cut = Math.max(room.lastIndexOf(', '), room.lastIndexOf('; '));
  return `${cut > 0 ? room.slice(0, cut) : room}${more}`;
}
