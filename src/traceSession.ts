import * as fs from 'fs/promises';
import * as path from 'path';
import type { WebviewMessage } from './messages';

export const TRACE_DIR_PREFIX = 'trace-';
export const MAX_TRACE_BYTES = 15 * 1024 * 1024;
export const MAX_TRACE_MS = 30 * 60 * 1000;

export interface ITrace {
  isRecording(): boolean;
  record(event: TraceEvent): void;
  noteTouchedProject(projectPath: string): void;
}

export type TraceEvent =
  | {
      kind: 'cli';
      at: string;
      command: string;
      args: string[];
      cwd?: string;
      exitCode: number | null;
      timedOut: boolean;
      durationMs: number;
      stdout: string;
      stderr: string;
    }
  | { kind: 'webview'; at: string; type: string; payload: unknown }
  | { kind: 'broker'; at: string; step: string; detail?: unknown };

interface SessionMeta {
  id: string;
  startedAt: string;
  status: 'recording';
  truncated?: boolean;
}

const PAYLOAD_MAX = 1500;

/** Truncate webview JSON so csproj bodies never land in jsonl. */
export function summarizeWebviewMessage(msg: WebviewMessage): unknown {
  const { type, ...rest } = msg as WebviewMessage & Record<string, unknown>;
  const slim: Record<string, unknown> = { type };
  for (const [key, value] of Object.entries(rest)) {
    if (key === 'items' && Array.isArray(value)) {
      slim.items = value.length;
      continue;
    }
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      slim[key] = value.map((v) => path.basename(v));
      continue;
    }
    if (typeof value === 'string' && value.length > 240) {
      slim[key] = `${value.slice(0, 240)}…`;
      continue;
    }
    slim[key] = value;
  }
  const encoded = JSON.stringify(slim);
  if (encoded.length <= PAYLOAD_MAX) return slim;
  return { type, truncated: true, bytes: encoded.length };
}

function sessionIdFromDate(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

export class TraceSession implements ITrace {
  readonly dir: string;
  readonly startedAt: Date;
  truncated = false;
  private readonly touched = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(dir: string, startedAt: Date, truncated: boolean) {
    this.dir = dir;
    this.startedAt = startedAt;
    this.truncated = truncated;
  }

  static async create(storageRoot: string, now = new Date()): Promise<TraceSession> {
    const id = sessionIdFromDate(now);
    const dir = path.join(storageRoot, `${TRACE_DIR_PREFIX}${id}`);
    await fs.mkdir(dir, { recursive: true });
    const meta: SessionMeta = { id, startedAt: now.toISOString(), status: 'recording' };
    await fs.writeFile(path.join(dir, 'session.json'), JSON.stringify(meta, null, 2), 'utf8');
    return new TraceSession(dir, now, false);
  }

  static async reopen(dir: string): Promise<TraceSession> {
    const raw = await fs.readFile(path.join(dir, 'session.json'), 'utf8');
    const meta = JSON.parse(raw) as SessionMeta;
    const session = new TraceSession(dir, new Date(meta.startedAt), !!meta.truncated);
    try {
      const touchedRaw = await fs.readFile(path.join(dir, 'touched.json'), 'utf8');
      const paths = JSON.parse(touchedRaw) as string[];
      for (const p of paths) session.touched.add(p);
    } catch {
      /* optional */
    }
    return session;
  }

  static async findOrphanDirs(storageRoot: string): Promise<string[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(storageRoot);
    } catch {
      return [];
    }
    const found: string[] = [];
    for (const name of names) {
      if (!name.startsWith(TRACE_DIR_PREFIX)) continue;
      const dir = path.join(storageRoot, name);
      try {
        const raw = await fs.readFile(path.join(dir, 'session.json'), 'utf8');
        const meta = JSON.parse(raw) as SessionMeta;
        if (meta.status === 'recording') found.push(dir);
      } catch {
        /* ignore */
      }
    }
    return found;
  }

  isRecording(): boolean {
    return !this.closed;
  }

  record(event: TraceEvent): void {
    if (this.closed) return;
    this.chain = this.chain.then(() => this._write(event)).catch(() => { /* never break CLI */ });
  }

  noteTouchedProject(projectPath: string): void {
    if (!projectPath) return;
    this.touched.add(projectPath);
    this.chain = this.chain.then(() => this._persistTouched()).catch(() => { /* ignore */ });
  }

  getTouchedProjects(): string[] {
    return [...this.touched];
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  jsonlPath(): string {
    return path.join(this.dir, 'trace.jsonl');
  }

  private async _persistTouched(): Promise<void> {
    await fs.writeFile(
      path.join(this.dir, 'touched.json'),
      JSON.stringify([...this.touched], null, 2),
      'utf8',
    );
  }

  private async _write(event: TraceEvent): Promise<void> {
    if (this.closed) return;
    if (Date.now() - this.startedAt.getTime() > MAX_TRACE_MS) {
      this.truncated = true;
      await this._markTruncated();
      return;
    }

    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(this.jsonlPath(), line, 'utf8');

    const size = await this._logBytes();
    if (size > MAX_TRACE_BYTES) {
      await this._dropOldestJsonl();
      this.truncated = true;
      await this._markTruncated();
    }
  }

  private async _logBytes(): Promise<number> {
    try {
      return (await fs.stat(this.jsonlPath())).size;
    } catch {
      return 0;
    }
  }

  private async _dropOldestJsonl(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.jsonlPath(), 'utf8');
    } catch {
      return;
    }
    const lines = text.split('\n').filter((l) => l.length > 0);
    const keep = lines.slice(Math.floor(lines.length / 2));
    await fs.writeFile(this.jsonlPath(), keep.length ? keep.join('\n') + '\n' : '', 'utf8');
  }

  private async _markTruncated(): Promise<void> {
    try {
      const raw = await fs.readFile(path.join(this.dir, 'session.json'), 'utf8');
      const meta = JSON.parse(raw) as SessionMeta;
      meta.truncated = true;
      await fs.writeFile(path.join(this.dir, 'session.json'), JSON.stringify(meta, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  }
}
