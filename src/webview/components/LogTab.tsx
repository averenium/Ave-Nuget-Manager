import React, { useEffect, useRef, useState } from 'react';
import { useNugetManager } from '../context/NugetManagerContext';
import type { LogEntry } from '../../types';

const PREVIEW_LINES = 3;

function splitLines(text: string): string[] {
  return (text ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

export function LogTab() {
  const { state, send } = useNugetManager();
  const { entries } = state.log;
  const recording = state.traceRecording;
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { send({ type: 'GET_LOG_ENTRIES' }); }, [send]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  return (
    <div className="log-tab" role="log" aria-label="Operation log" aria-live="polite">
      <div className="log-toolbar">
        {recording ? (
          <button
            type="button"
            className="log-toolbar__btn log-toolbar__btn--stop"
            onClick={() => send({ type: 'STOP_TRACE' })}
          >
            ■ Stop & save zip
          </button>
        ) : (
          <button
            type="button"
            className="log-toolbar__btn"
            onClick={() => send({ type: 'START_TRACE' })}
          >
            ● Trace
          </button>
        )}
        {recording && (
          <span className="log-toolbar__badge" title="Diagnostic trace is recording">
            recording
          </span>
        )}
        <span className="log-toolbar__spacer" />
        <button
          type="button"
          className="log-toolbar__btn"
          onClick={() => send({ type: 'CLEAR_LOG' })}
        >
          Clear log
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="empty-state">No operations logged yet</div>
      ) : (
        <div className="log-tab__list">
          {entries.map((entry) => <LogEntryRow key={entry.id} entry={entry} />)}
          <div ref={bottomRef} />
        </div>
      )}
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
      <div className="log-entry__summary">
        <span className="log-entry__ts">{ts}</span>
        <span className="log-entry__duration">{durationLabel}</span>
        <span className="log-entry__cmd">{entry.command}</span>
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

      {previewLines.length > 0 && (
        <div className="log-entry__preview">
          {previewLines.map((l, i) => (
            <pre key={i} className={`log-entry__body log-entry__body--${l.kind === 'err' ? 'stderr' : 'stdout'}`}>
              {l.text}
            </pre>
          ))}
        </div>
      )}

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
