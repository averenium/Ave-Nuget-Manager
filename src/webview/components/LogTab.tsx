import React, { useEffect, useRef, useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import type { LogEntry } from '../../types';

const PREVIEW_LINES = 3;

/** Split text into non-empty lines, return first N and the rest separately */
function splitLines(text: string): string[] {
  return (text ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

export function LogTab() {
  const { state, send } = useNugetManager();
  const { entries } = state.log;
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { send({ type: 'GET_LOG_ENTRIES' }); }, [send]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <div className="log-tab" role="log" aria-label="Operation log" aria-live="polite">
        <div className="empty-state">No operations logged yet</div>
      </div>
    );
  }

  return (
    <div className="log-tab" role="log" aria-label="Operation log" aria-live="polite">
      {entries.map((entry) => <LogEntryRow key={entry.id} entry={entry} />)}
      <div ref={bottomRef} />
    </div>
  );
}

function LogEntryRow({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);

  const exitClass = entry.timedOut
    ? 'log-entry__exit--timeout'
    : entry.exitCode === 0 ? 'log-entry__exit--ok' : 'log-entry__exit--err';

  const exitLabel = entry.timedOut
    ? 'TIMEOUT'
    : entry.exitCode !== null ? `exit ${entry.exitCode}` : '—';

  // Full command = command + args joined
  const fullCommand = entry.command;

  // All non-empty output lines
  const stdoutLines = splitLines(entry.stdout);
  const stderrLines = splitLines(entry.stderr);
  const allLines = [
    ...stdoutLines.map((l) => ({ text: l, kind: 'out' as const })),
    ...stderrLines.map((l) => ({ text: l, kind: 'err' as const })),
  ];

  const previewLines = allLines.slice(0, PREVIEW_LINES);
  const remainingLines = allLines.slice(PREVIEW_LINES);
  const hasMore = remainingLines.length > 0;

  const ts = new Date(entry.timestamp).toLocaleTimeString();
  const durationLabel = (entry.durationMs ?? 0) >= 1000
    ? `${((entry.durationMs ?? 0) / 1000).toFixed(1)}s`
    : `${entry.durationMs ?? 0}ms`;

  return (
    <div className="log-entry">
      {/* Line 1: timestamp + duration + full command + exit */}
      <div className="log-entry__summary">
        <span className="log-entry__ts">{ts}</span>
        <span className="log-entry__duration">{durationLabel}</span>
        <span className="log-entry__cmd">{fullCommand}</span>
        <span className={`log-entry__exit ${exitClass}`}>[{exitLabel}]</span>
        {hasMore && (
          <button
            className="log-entry__toggle"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? '▲' : `▼ +${remainingLines.length}`}
          </button>
        )}
      </div>

      {/* Lines 2–4: first 3 output lines (always visible) */}
      {previewLines.length > 0 && (
        <div className="log-entry__preview">
          {previewLines.map((l, i) => (
            <pre key={i} className={`log-entry__body log-entry__body--${l.kind === 'err' ? 'stderr' : 'stdout'}`}>
              {l.text}
            </pre>
          ))}
        </div>
      )}

      {/* Remaining lines (only shown when expanded, no duplication) */}
      {open && hasMore && (
        <div className="log-entry__details">
          {remainingLines.map((l, i) => (
            <pre key={i} className={`log-entry__body log-entry__body--${l.kind === 'err' ? 'stderr' : 'stdout'}`}>
              {l.text}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}
