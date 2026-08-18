import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { LogEntry } from './types';

export interface CliLogEntry {
  timestamp: Date;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export type LogListener = (entry: LogEntry) => void;

export class Logger {
  private readonly channel: vscode.OutputChannel;
  private readonly entries: LogEntry[] = [];
  private readonly listeners: Set<LogListener> = new Set();

  constructor() {
    this.channel = vscode.window.createOutputChannel('Averenium NuGet Manager');
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
      command: op.command,
      args: op.args,
      stdout: op.stdout,
      stderr: op.stderr,
      exitCode: op.exitCode,
      timedOut: op.timedOut,
      durationMs: op.durationMs,
    };

    this.entries.push(entry);
    this._writeToChannel(entry);
    this._notifyListeners(entry);
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

  // ─── Private helpers ──────────────────────────────────────────────────────

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
