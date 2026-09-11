import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import { summarizeDotnetFailure, summarizeListProblems } from '../../dotnetOutput';
import { IconCopy, IconBroom, IconShieldBadge, IconOutputPanel, IconRecordDot, IconStopSquare } from '../utils/icons';
import type { LogEntry, LogEntryKind } from '../../types';
import { useFocusSearchOnFind } from '../utils/useFocusSearchOnFind';

type KindFilter = 'all' | 'error' | 'cli' | 'edit';

const NU_CODE_RE = /\bNU\d{4}\b/;
const BOTTOM_SLACK_PX = 24;
/** Below this, a command fits the row on one line — splitting it too would
 *  just waste a line on something like "dotnet --version" (#58 follow-up). */
const CLI_SPLIT_THRESHOLD = 48;

function formatClock(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** "Today" / "Yesterday" / an explicit date — never locale-formatted (#52/#58). */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const oneDay = 24 * 60 * 60 * 1000;
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / oneDay);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function firstErrorLine(entry: LogEntry): string {
  // `--format json` commands (package search, list) report failure as a
  // "problems" array, not plain-text `error:`/NUxxxx lines — check that
  // shape first, since summarizeDotnetFailure's line heuristics don't
  // recognize it and fall back to just the raw JSON's first line ("{").
  const jsonProblem = summarizeListProblems(entry.stdout) ?? summarizeListProblems(entry.stderr);
  const summary = jsonProblem ?? summarizeDotnetFailure(entry.stdout, entry.stderr);
  const line = summary.split('\n').map((l) => l.trim()).find(Boolean);
  return line ?? (entry.timedOut ? 'Operation timed out' : 'Failed');
}

/**
 * `cli` entries store the full command as one string ("dotnet package search
 * Foo --exact-match --configfile <long path> --format json"), which used to
 * render on one line, truncated with an ellipsis, with no way to read the
 * rest short of expanding the row. Split at the first `-`/`--` flag, so the
 * command-and-target part stays together on the main line and the (often
 * long, path-heavy) flags wrap onto their own smaller-font line instead.
 */
function splitCliCommand(command: string): { main: string; detail?: string } {
  if (command.length <= CLI_SPLIT_THRESHOLD) return { main: command };
  const tokens = command.split(' ');
  const flagIndex = tokens.findIndex((t) => t.startsWith('-'));
  if (flagIndex <= 0) return { main: command };
  return { main: tokens.slice(0, flagIndex).join(' '), detail: tokens.slice(flagIndex).join(' ') };
}

type CopyPos = 'top' | 'bottom';

/** Below this, a top+bottom button pair would overlap — just use top (#66 follow-up). */
const COPY_HOVER_SPLIT_MIN_PX = 48;

/**
 * A `<pre>` block with a Copy button that only shows up on hover. It stays
 * pinned to the right edge (not under the cursor, which would sit on top of
 * whatever text is being read) and snaps to whichever of 2 fixed slots — top
 * or bottom — is nearest the cursor, rather than continuously tracking it
 * (which felt jittery/unpredictable) or sitting stuck in a fixed top corner
 * far from a tall block's content (#66).
 */
function CopyableBlock({ className, text }: { className: string; text: string }) {
  const { send } = useNugetManager();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CopyPos>('top');

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const height = el.offsetHeight;
    if (height < COPY_HOVER_SPLIT_MIN_PX) {
      setPos('top');
      return;
    }
    const fraction = (e.clientY - el.getBoundingClientRect().top) / height;
    setPos(fraction < 0.5 ? 'top' : 'bottom');
  };

  return (
    <div className="log-row__copyable" ref={ref} onMouseMove={handleMove} data-copy-pos={pos}>
      <pre className={className}>{text}</pre>
      <button
        type="button"
        className="log-row__copy-hover"
        title="Copy"
        aria-label="Copy"
        onClick={() => send({ type: 'COPY_TEXT', text })}
      >
        <IconCopy />
      </button>
    </div>
  );
}

function kindLabel(kind: LogEntryKind): string {
  return kind === 'error' ? 'error' : kind;
}

function matchesKindFilter(entry: LogEntry, filter: KindFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'error') return entry.kind === 'error' || (entry.exitCode !== 0 && entry.exitCode !== null) || entry.timedOut;
  if (filter === 'cli') return entry.kind === 'cli';
  return entry.kind === 'edit' || entry.kind === 'scan' || entry.kind === 'info';
}

function matchesSearch(entry: LogEntry, query: string): boolean {
  if (!query) return true;
  const haystack = [entry.command, entry.args.join(' '), entry.stdout, entry.stderr].join('\n').toLowerCase();
  return haystack.includes(query);
}

export function LogTab() {
  const { state, send } = useNugetManager();
  const { entries } = state.log;
  const recording = state.traceRecording;
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useFocusSearchOnFind(searchRef);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [pendingCount, setPendingCount] = useState(0);
  const prevLengthRef = useRef(entries.length);
  // Suppress hover during scroll: rows pass under a stationary cursor, and
  // the browser's own hover hit-testing toggles each copy-hover button's
  // `:hover` state as they cross it, which reads as flicker (#66 follow-up).
  const [scrolling, setScrolling] = useState(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => { send({ type: 'GET_LOG_ENTRIES' }); }, [send]);
  useEffect(() => () => clearTimeout(scrollTimerRef.current), []);

  const handleScroll = () => {
    setScrolling(true);
    clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => setScrolling(false), 150);
  };

  const isAtBottom = () => {
    const el = listRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
  };

  // Stick to the bottom only if the view was already there — otherwise show
  // a "N new" pill instead of yanking the scroll position (#51).
  useEffect(() => {
    const grew = entries.length - prevLengthRef.current;
    prevLengthRef.current = entries.length;
    if (grew <= 0) return;
    const el = listRef.current;
    if (!el) return;
    if (isAtBottom()) {
      el.scrollTop = el.scrollHeight;
    } else {
      setPendingCount((c) => c + grew);
    }
  }, [entries.length]);

  const scrollToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
    setPendingCount(0);
  };

  const query = search.trim().toLowerCase();
  const filtered = useMemo(
    () => entries.filter((e) => matchesKindFilter(e, kindFilter) && matchesSearch(e, query)),
    [entries, kindFilter, query],
  );

  const copyVisible = () => {
    const text = filtered.map((e) => {
      const head = `[${e.timestamp}] ${e.command}${e.args.length ? ' ' + e.args.join(' ') : ''}`;
      const body = [e.stdout, e.stderr].filter((s) => s.trim().length > 0).join('\n');
      return body ? `${head}\n${body}` : head;
    }).join('\n\n');
    send({ type: 'COPY_TEXT', text });
  };

  const copySanitized = () => {
    const text = filtered.map((e) => {
      const head = `[${e.timestamp}] ${e.command}${e.args.length ? ' ' + e.args.join(' ') : ''}`;
      const body = [e.stdout, e.stderr].filter((s) => s.trim().length > 0).join('\n');
      return body ? `${head}\n${body}` : head;
    }).join('\n\n');
    send({ type: 'COPY_LOG_SANITIZED', text });
  };

  let lastDay: string | null = null;

  return (
    <div className="log-tab" role="log" aria-label="Operation log">
      <div className="pkg-toolbar">
        {recording ? (
          <button
            type="button"
            className="log-trace-btn log-trace-btn--recording"
            onClick={() => send({ type: 'STOP_TRACE' })}
            title="Stop & save the trace zip"
          >
            <IconStopSquare /> Stop
          </button>
        ) : (
          <button
            type="button"
            className="log-trace-btn"
            onClick={() => send({ type: 'START_TRACE' })}
            title="Start a diagnostic trace"
          >
            <IconRecordDot /> Trace
          </button>
        )}
        <input
          ref={searchRef}
          type="search"
          className="pkg-toolbar__search"
          placeholder="Search commands, args, output…"
          value={search}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search log entries"
        />
        {recording && (
          <span className="log-toolbar__badge" title="Diagnostic trace is recording">
            recording
          </span>
        )}
        <select
          className="log-kind-select"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as KindFilter)}
          aria-label="Filter by kind"
        >
          <option value="all">All</option>
          <option value="error">Errors</option>
          <option value="cli">CLI</option>
          <option value="edit">Edits</option>
        </select>
        <div className="log-toolbar__divider" />
        <button
          type="button"
          className="pkg-toolbar__refresh"
          onClick={copyVisible}
          title="Copy visible entries"
          aria-label="Copy visible entries"
        >
          <IconCopy />
        </button>
        <button
          type="button"
          className="pkg-toolbar__refresh log-toolbar__icon-btn--badged"
          onClick={copySanitized}
          title="Copy visible entries, sanitised (safe to paste into a public issue)"
          aria-label="Copy visible entries, sanitised"
        >
          <IconCopy />
          <span className="log-toolbar__badge-icon"><IconShieldBadge /></span>
        </button>
        <button
          type="button"
          className="pkg-toolbar__refresh"
          onClick={() => send({ type: 'OPEN_LOG_OUTPUT' })}
          title="Open the Output channel — full, unbounded log"
          aria-label="Open Output channel"
        >
          <IconOutputPanel />
        </button>
        <button
          type="button"
          className="pkg-toolbar__refresh"
          onClick={() => send({ type: 'CLEAR_LOG' })}
          title="Clear log"
          aria-label="Clear log"
        >
          <IconBroom />
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="empty-state">No operations logged yet</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">No entries match this search/filter</div>
      ) : (
        // The pill lives in this non-scrolling wrapper, not inside
        // `.log-tab__list` itself — that element is the scroll container, so
        // an absolutely-positioned child of it scrolls away with the content
        // instead of staying pinned to the visible bottom edge (#66 follow-up).
        <div className="log-tab__list-wrap">
          <div
            className={`log-tab__list${scrolling ? ' log-tab__list--scrolling' : ''}`}
            ref={listRef}
            onScroll={handleScroll}
          >
            {filtered.map((entry) => {
              const day = dayLabel(entry.timestamp);
              const showSep = day !== lastDay;
              lastDay = day;
              return (
                <React.Fragment key={entry.id}>
                  {showSep && <div className="log-day-sep">{day}</div>}
                  <LogRow entry={entry} />
                </React.Fragment>
              );
            })}
          </div>
          {pendingCount > 0 && (
            <button type="button" className="log-tab__new-pill" onClick={scrollToBottom}>
              {pendingCount} new ↓
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);

  const failed = entry.kind === 'error' || (entry.exitCode !== 0 && entry.exitCode !== null) || entry.timedOut;
  const exitClass = entry.timedOut
    ? 'log-row__exit--timeout'
    : failed ? 'log-row__exit--err' : 'log-row__exit--ok';
  const nuCode = failed ? (entry.stderr.match(NU_CODE_RE) ?? entry.stdout.match(NU_CODE_RE))?.[0] : undefined;
  const exitLabel = entry.timedOut
    ? 'TIMEOUT'
    : nuCode ?? (entry.exitCode !== null ? (failed ? `exit ${entry.exitCode}` : 'ok') : failed ? 'fail' : 'ok');

  // `cli` entries embed args in `command` itself ("dotnet <args>") — split
  // off the stable "dotnet <verb>" prefix so a long one still gets a second,
  // smaller-font line instead of a single truncated ellipsis. Synthetic
  // entries keep the payload separately in `args`, previously dropped
  // entirely (#58 #1) — shown the same way.
  const { main: cmdMain, detail: cmdDetail } = entry.kind === 'cli'
    ? splitCliCommand(entry.command)
    : { main: entry.command, detail: entry.args.join(' ') || undefined };
  const fullCmd = entry.kind === 'cli' ? entry.command : `${entry.command}${cmdDetail ? ' ' + cmdDetail : ''}`;
  const errPreview = !open && failed ? firstErrorLine(entry) : undefined;

  return (
    <div className={`log-row${open ? ' log-row--open' : ''}`}>
      <div className="log-row__summary" onClick={() => setOpen((o) => !o)}>
        <svg className="log-row__chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M6 3.5l5 4.5-5 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="log-row__ts" title={entry.timestamp}>{formatClock(entry.timestamp)}</span>
        <span className="log-row__dur">{formatDuration(entry.durationMs)}</span>
        <span className={`log-row__kind log-row__kind--${entry.kind}`}>{kindLabel(entry.kind)}</span>
        <span className="log-row__cmd" title={fullCmd}>
          <span className="log-row__cmd-main">{cmdMain}</span>
          {cmdDetail && <span className="log-row__cmd-detail">{cmdDetail}</span>}
        </span>
        <span className={`log-row__exit ${exitClass}`}>{exitLabel}</span>
      </div>

      {errPreview && (
        <button type="button" className="log-row__err-preview" onClick={() => setOpen(true)}>
          <span>{errPreview}</span>
        </button>
      )}

      {open && (
        <div className="log-row__body">
          {entry.kind === 'cli' ? (
            <>
              <div className="log-row__stream-label">command</div>
              <CopyableBlock className="log-row__cmd-full" text={fullCmd} />
              {entry.stdout.trim() && (
                <>
                  <div className="log-row__stream-label">stdout</div>
                  <CopyableBlock className="log-row__stream" text={entry.stdout} />
                </>
              )}
              {entry.stderr.trim() && (
                <>
                  <div className="log-row__stream-label">stderr</div>
                  <CopyableBlock className="log-row__stream log-row__stream--stderr" text={entry.stderr} />
                </>
              )}
            </>
          ) : (
            // The summary row already shows the full label + args — no
            // separate "command" heading here. But the label is still the
            // only content for entries with no stdout/stderr (most `edit`
            // operations), so it's folded into the same block as any
            // stdout/stderr instead of being dropped (#66 follow-up).
            <CopyableBlock
              className={`log-row__cmd-full${failed ? ' log-row__stream--stderr' : ''}`}
              text={[fullCmd, entry.stdout, entry.stderr].filter((s) => s.trim().length > 0).join('\n\n')}
            />
          )}
          {nuCode && (
            <a
              className="log-row__nu-chip"
              href={`https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/${nuCode.toLowerCase()}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {nuCode} ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}
