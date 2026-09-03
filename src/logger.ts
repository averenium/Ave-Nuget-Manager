import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { LogEntry, LogEntryKind } from './types';

export interface CliLogEntry {
  timestamp: Date;
  /** Defaults to 'cli' — every real `dotnet` invocation goes through one call
   *  site (`cliRunner.ts`); the handful of synthetic (non-CLI) callers in
   *  `webviewMessageBroker.ts` pass their own kind explicitly (#58). */
  kind?: LogEntryKind;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export type LogListener = (entry: LogEntry) => void;

/** Ring-buffer cap — the Output Channel (`_writeToChannel`) stays unbounded. */
const MAX_ENTRIES = 500;

export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  return String(err);
}

export class Logger {
  private readonly channel: vscode.OutputChannel;
  private readonly entries: LogEntry[] = [];
  private readonly listeners: Set<LogListener> = new Set();

  constructor() {
    this.channel = vscode.window.createOutputChannel('Averenium NuGet Manager');
  }

  /** Host diagnostic — Output Channel, and the Log tab as an `info` row (#58). */
  info(message: string): void {
    this._writePlain('info', message);
    this._pushSynthetic('info', message);
  }

  /** Host failure — Output Channel, Extension Host console, and the Log tab as an `error` row (#58). */
  error(message: string, err?: unknown): void {
    const detail = err !== undefined ? formatUnknownError(err) : '';
    const full = detail ? `${message}\n${detail}` : message;
    this._writePlain('error', full);
    this._pushSynthetic('error', full);
    try {
      console.error(`[AVE NuGet Manager] ${message}`, err ?? '');
    } catch {
      /* console must never break activate */
    }
  }

  /**
   * Record a completed CLI operation. Writes to the Output Channel and
   * notifies all subscribers. Subscriber errors are swallowed so that a
   * bad listener never blocks the calling operation.
   */
  logCliOperation(op: CliLogEntry): void {
    const entry: LogEntry = {
      id: randomUUID(),
      timestamp: op.timestamp.toISOString(),
      kind: op.kind ?? 'cli',
      command: op.command,
      args: op.args,
      stdout: op.stdout,
      stderr: op.stderr,
      exitCode: op.exitCode,
      timedOut: op.timedOut,
      durationMs: op.durationMs,
    };

    this._pushEntry(entry);
    this._writeToChannel(entry);
    this._notifyListeners(entry);
  }

  /** `info`/`error` as a bodyless Log-tab row — the message is the "command" text. */
  private _pushSynthetic(kind: 'info' | 'error', message: string): void {
    const entry: LogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      kind,
      command: message.split('\n')[0],
      args: [],
      stdout: '',
      stderr: kind === 'error' ? message : '',
      exitCode: null,
      timedOut: false,
      durationMs: 0,
    };
    this._pushEntry(entry);
    this._notifyListeners(entry);
  }

  private _pushEntry(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
  }

  /** Returns all recorded log entries in chronological order. */
  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  /**
   * Subscribe to new log entries. Returns a `Disposable` that removes the
   * listener when disposed.
   */
  subscribe(listener: LogListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.delete(listener);
    });
  }

  /** Reveal the Output Channel in the UI. */
  show(): void {
    this.channel.show(true);
  }

  /** Dispose the Output Channel and clear all listeners. */
  dispose(): void {
    this.listeners.clear();
    this.channel.dispose();
  }

  /** Wipe in-memory entries and the Output Channel. Does not touch a trace session. */
  clear(): void {
    this.entries.length = 0;
    try {
      this.channel.clear();
    } catch {
      // Output channel errors must never propagate
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private _writePlain(level: 'info' | 'error', message: string): void {
    try {
      const ts = new Date().toISOString();
      for (const line of message.split('\n')) {
        this.channel.appendLine(`[${ts}] [${level}] ${line}`);
      }
    } catch {
      // Output channel errors must never propagate
    }
  }

  private _writeToChannel(entry: LogEntry): void {
    try {
      const statusPart = entry.timedOut
        ? ' [TIMEOUT]'
        : entry.exitCode !== null
          ? ` [exit ${entry.exitCode}]`
          : '';
      this.channel.appendLine(`[${entry.timestamp}] ${entry.command}${statusPart}`);
      if (entry.args.length > 0) {
        this.channel.appendLine(`  args: ${entry.args.join(' ')}`);
      }
      if (entry.stdout.trim()) {
        this.channel.appendLine('  stdout:');
        for (const line of entry.stdout.split('\n')) {
          this.channel.appendLine(`    ${line}`);
        }
      }
      if (entry.stderr.trim()) {
        this.channel.appendLine('  stderr:');
        for (const line of entry.stderr.split('\n')) {
          this.channel.appendLine(`    ${line}`);
        }
      }
      this.channel.appendLine('');
    } catch {
      // Output channel errors must never propagate
    }
  }

  private _notifyListeners(entry: LogEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Individual listener errors must never propagate to the caller
      }
    }
  }
}
