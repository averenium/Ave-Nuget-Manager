import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNugetManager } from '../context/NugetManagerContext';
import { SplitPane } from './SplitPane';
import { fileName } from '../utils/pathUtils';
import { IconPencil, IconTrash } from '../utils/icons';
import { AUDIT_SOURCES_HINT, snapshotNeedsSourcesWarn } from '../../vulnerabilityScanPolicy';
import { nugetApiKeyExportCommand } from '../../nugetApiKeyEnv';
import { SourceUrlMenu } from './SourceUrlMenu';
import type {
  ChainChange,
  EffectiveSourceRow,
  ExtraConfigFileView,
  FeedKind,
  NuGetConfigFile,
  PackageSource,
} from '../../types';

type Selection = { kind: 'effective' } | { kind: 'file'; path: string };
type RepoKind = 'package' | 'audit';
type Editing = { kind: RepoKind; name: string } | null;

const LIST_RATIO = 0.35;

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

function asList<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function feedKindFromUrl(url: string): FeedKind {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'data.nuget.org') return 'data.nuget.org';
    if (host === 'api.nuget.org' || host === 'nuget.org' || host === 'www.nuget.org') {
      return 'nuget.org';
    }
    if (url.startsWith('http://') || url.startsWith('https://')) return 'http';
  } catch {
    /* folder / UNC */
  }
  return /^https?:\/\//i.test(url) ? 'http' : 'local';
}

function rowFromPackageSource(src: PackageSource, file: NuGetConfigFile): EffectiveSourceRow {
  const key = src.name.toLowerCase();
  const creds = new Set((file.credentialKeys ?? []).map((k) => k.toLowerCase()));
  const users = file.credentialUsernames ?? {};
  const username = users[src.name] ?? users[key];
  return {
    name: src.name,
    url: src.url,
    enabled: src.enabled,
    kind: feedKindFromUrl(src.url),
    hasCredentials: creds.has(key),
    username,
    hasApiKey: false,
    allowInsecureConnections: src.allowInsecureConnections,
    disableTlsCertificateValidation: src.disableTlsCertificateValidation,
    configFilePath: src.configFilePath || file.filePath,
    protocolVersion: src.protocolVersion,
  };
}

function reposFromParsedFile(file: NuGetConfigFile): {
  package: EffectiveSourceRow[];
  audit: EffectiveSourceRow[];
} {
  return {
    package: asList(file.sources).map((s) => rowFromPackageSource(s, file)),
    audit: asList(file.auditSources).map((s) => rowFromPackageSource(s, file)),
  };
}

function sourceKey(kind: RepoKind, name: string): string {
  return `${kind}:${name.toLowerCase()}`;
}

function summarizeChanges(changes: ChainChange[]): string {
  const parts: string[] = [];
  for (const change of changes) {
    switch (change.kind) {
      case 'cleared-package':
        parts.push('cleared package sources');
        break;
      case 'cleared-audit':
        parts.push('cleared audit sources');
        break;
      case 'added':
        parts.push(`added ${change.name}`);
        break;
      case 'replaced':
        parts.push(`replaced ${change.name}`);
        break;
      case 'disabled':
        parts.push(`${change.name} off`);
        break;
      case 'overridden':
        parts.push(`${change.name} unused`);
        break;
    }
  }
  return parts.join(' · ');
}

function extraRoleLabel(file: ExtraConfigFileView): string {
  if (file.role === 'applies') return `applies to ${asList(file.appliesToProjectNames).join(', ')}`;
  return 'not used in this scope';
}

function configLayer(file: { isGlobal?: boolean; isMachineWide?: boolean }): 'workspace' | 'global' | 'machine' {
  if (file.isMachineWide) return 'machine';
  if (file.isGlobal) return 'global';
  return 'workspace';
}

function isMachineConfigPath(filePath: string, chain: { filePath: string; isMachineWide?: boolean }[]): boolean {
  return chain.some((f) => f.isMachineWide && samePath(f.filePath, filePath));
}

function ConfigFilesSection({
  title,
  count,
  label,
  children,
}: {
  title: string;
  count?: number;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="pkg-section">
      <div className="pkg-section__header">
        <span>{title}</span>
        {count !== undefined ? <span>{count}</span> : null}
      </div>
      <div className="pkg-section__list" role="listbox" aria-label={label}>
        {children}
      </div>
    </section>
  );
}

function scopeTitle(scope: { kind: string; solutionPath?: string; projectPath?: string; folderPath?: string } | null): string {
  if (!scope) return 'current scope';
  if (scope.kind === 'solution' && scope.solutionPath) return fileName(scope.solutionPath);
  if (scope.kind === 'folder' && scope.folderPath) return fileName(scope.folderPath);
  if (scope.projectPath) return fileName(scope.projectPath);
  return 'current scope';
}

function ConfigRow({
  title,
  meta,
  warning,
  warn,
  selected,
  onSelect,
  onOpen,
}: {
  title: string;
  meta: string;
  warning?: string;
  warn?: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpen?: () => void;
}) {
  return (
    <div
      className={`pkg-row${selected ? ' pkg-row--selected' : ''}`}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={(e) => {
        e.preventDefault();
        onOpen?.();
      }}
      title={onOpen ? 'Double-click to open' : undefined}
    >
      <div className="pkg-row__title">
        <span className="pkg-row__name" title={title}>{title}</span>
        {warn ? (
          <span className="tab-btn__warn" title="No working audit source">⚠</span>
        ) : null}
      </div>
      {meta ? (
        <div className="pkg-row__meta">
          <span className="pkg-row__version" title={meta}>{meta}</span>
        </div>
      ) : null}
      {warning ? (
        <div className="pkg-row__meta">
          <span className="pkg-row__latest pkg-row__latest--fail">{warning}</span>
        </div>
      ) : null}
    </div>
  );
}

function Badge({
  label,
  title,
  tone,
}: {
  label: string;
  title: string;
  tone: 'on' | 'off' | 'set';
}) {
  return (
    <span className={`sources-badge sources-badge--${tone}`} title={title}>
      {label}
    </span>
  );
}

function FlagIcon({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <span className="sources-flag" title={title} role="img" aria-label={title}>
      {children}
    </span>
  );
}

function IconUnlock() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12.5 7H6V4.75A2.75 2.75 0 0 1 11.2 3.4a.75.75 0 1 0 1.1-1.02A4.25 4.25 0 0 0 4.5 4.75V7H3.5A1.5 1.5 0 0 0 2 8.5v5A1.5 1.5 0 0 0 3.5 15h9A1.5 1.5 0 0 0 14 13.5v-5A1.5 1.5 0 0 0 12.5 7Zm0 1.5v5h-9v-5h9Z"
      />
    </svg>
  );
}

function IconNoTls() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        d="M8 1.4 13.2 3.5v4.1c0 3.3-2.1 5.5-5.2 6.5-3.1-1-5.2-3.2-5.2-6.5V3.5L8 1.4Z"
      />
      <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M3.2 3.4 12.8 12.7" />
    </svg>
  );
}

function IconKey() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        fill="currentColor"
        d="M7.75 2.5a3.75 3.75 0 0 0-1.3 7.27L4 12.2V14h2v-1h1.5l2.1-2.1A3.75 3.75 0 1 0 7.75 2.5Zm0 2a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Z"
      />
    </svg>
  );
}

function DestHint({ dest, title }: { dest: string; title: string }) {
  return (
    <span className="sources-edit__dest" title={title}>
      → {dest}
    </span>
  );
}

function destHelpNeeded(viewPath: string | null, destPath: string | undefined): boolean {
  return !viewPath || !destPath || !samePath(viewPath, destPath);
}

/**
 * Small anchored card, portaled to `document.body` so it overlays the list
 * instead of pushing rows below it down. Right edge aligns under `anchorRef`,
 * flips above it if there isn't room below. Closes on outside click, Escape,
 * blur, or scroll (same behavior as `SourceUrlMenu`).
 */
function AnchoredPanel({
  anchorRef,
  onClose,
  title,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const el = rootRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const left = Math.min(Math.max(4, a.right - r.width), window.innerWidth - r.width - 4);
    let top = a.bottom + 4;
    if (top + r.height > window.innerHeight - 4) {
      top = Math.max(4, a.top - r.height - 4);
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });

  useEffect(() => {
    const close = () => onCloseRef.current();
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [anchorRef]);

  return createPortal(
    <div
      ref={rootRef}
      className="sources-popover"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="sources-popover__header">
        <span className="sources-popover__title">{title}</span>
        <button
          type="button"
          className="sources-popover__close"
          title="Close"
          aria-label="Close"
          onClick={() => onCloseRef.current()}
        >
          ×
        </button>
      </div>
      {children}
    </div>,
    document.body,
  );
}

function RepoEditor({
  src,
  fileLabel,
  enableDest,
  enableTitle,
  secretsDest,
  secretsTitle,
  showEnableDest,
  showFlagsDest,
  showSecretsDest,
  onToggle,
  onFlags,
  onSave,
  onMapping,
  onCopyApiKeyExport,
  onClearCredentials,
  onClearApiKey,
  isWindows,
}: {
  src: EffectiveSourceRow;
  fileLabel: string;
  enableDest: string;
  enableTitle: string;
  secretsDest: string;
  secretsTitle: string;
  showEnableDest: boolean;
  showFlagsDest: boolean;
  showSecretsDest: boolean;
  onToggle: () => void;
  onFlags: (allowInsecureConnections: boolean, disableTlsCertificateValidation: boolean) => void;
  onSave: (username: string, password: string | undefined, apiKey: string | undefined) => void;
  /** `packageSourceMapping` only applies to `<packageSources>` — omit for an audit-only source. */
  onMapping?: (patterns: string[]) => void;
  onCopyApiKeyExport: (command: string) => void;
  onClearCredentials: () => void;
  onClearApiKey: () => void;
  isWindows: boolean;
}) {
  const [username, setUsername] = useState(src.username ?? '');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [insecure, setInsecure] = useState(!!src.allowInsecureConnections);
  const [noTls, setNoTls] = useState(!!src.disableTlsCertificateValidation);
  const patternsFromSrc = (src.mappingPatterns ?? []).join(', ');
  const [mapping, setMapping] = useState(patternsFromSrc);
  const pendingRef = useRef({
    username,
    password,
    apiKey,
    origUser: src.username ?? '',
    onSave,
  });
  pendingRef.current = {
    username,
    password,
    apiKey,
    origUser: src.username ?? '',
    onSave,
  };

  useEffect(() => {
    setUsername(src.username ?? '');
    setPassword('');
    setApiKey('');
    setInsecure(!!src.allowInsecureConnections);
    setNoTls(!!src.disableTlsCertificateValidation);
    setMapping((src.mappingPatterns ?? []).join(', '));
  }, [
    src.name,
    src.configFilePath,
    src.username,
    src.hasCredentials,
    src.hasApiKey,
    src.allowInsecureConnections,
    src.disableTlsCertificateValidation,
    src.mappingPatterns,
  ]);

  const mappingPatterns = mapping.split(',').map((p) => p.trim()).filter(Boolean);
  const mappingDirty = mappingPatterns.join(', ') !== patternsFromSrc;

  const persistSecrets = () => {
    const pending = pendingRef.current;
    const userChanged = pending.username !== pending.origUser;
    const passTyped = pending.password.length > 0;
    const keyTyped = pending.apiKey.length > 0;
    if (!userChanged && !passTyped && !keyTyped) return;
    pending.onSave(
      pending.username,
      passTyped ? pending.password : undefined,
      keyTyped ? pending.apiKey : undefined,
    );
    setPassword('');
    setApiKey('');
  };

  const dirty = username !== (src.username ?? '') || password.length > 0 || apiKey.length > 0;
  const onSecretKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    persistSecrets();
  };
  const flagsDest = showFlagsDest ? (
    <DestHint
      dest={fileLabel}
      title={`HTTP / TLS flags write to this <add> in ${fileLabel}.`}
    />
  ) : null;

  return (
    <div className="sources-edit" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <div className="sources-edit__row">
        <label className="sources-check" title={enableTitle}>
          <input type="checkbox" checked={src.enabled} onChange={onToggle} />
          <span>enabled</span>
        </label>
        {showEnableDest ? (
          <DestHint dest={enableDest} title={enableTitle} />
        ) : null}
      </div>
      <div className="sources-edit__row">
        <label className="sources-check">
          <input
            type="checkbox"
            checked={insecure}
            onChange={() => {
              const next = !insecure;
              setInsecure(next);
              onFlags(next, noTls);
            }}
          />
          <IconUnlock />
          <span title="Allow HTTP for this source">allowInsecureConnections</span>
        </label>
        {flagsDest}
      </div>
      <div className="sources-edit__row">
        <label className="sources-check">
          <input
            type="checkbox"
            checked={noTls}
            onChange={() => {
              const next = !noTls;
              setNoTls(next);
              onFlags(insecure, next);
            }}
          />
          <IconNoTls />
          <span title="Ignore TLS certificate errors for this source">disableTLSCertificateValidation</span>
        </label>
        {flagsDest}
      </div>
      {onMapping ? (
        <div className="sources-edit__row">
          <input
            className="sources-input"
            value={mapping}
            autoComplete="off"
            spellCheck={false}
            placeholder="packageSourceMapping patterns, e.g. Example.*, Internal.*"
            title={`packageSourceMapping patterns for this source, comma-separated. Empty clears it. Writes to ${fileLabel}.`}
            onChange={(e) => setMapping(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (mappingDirty) onMapping(mappingPatterns);
            }}
          />
          <button
            type="button"
            className="btn btn--secondary sources-save"
            disabled={!mappingDirty}
            onClick={() => onMapping(mappingPatterns)}
          >
            Save mapping
          </button>
        </div>
      ) : null}
      <div className="sources-field">
        <input
          className="sources-input"
          value={username}
          autoComplete="off"
          spellCheck={false}
          placeholder="username"
          title={showSecretsDest ? `Username written to ${secretsDest}.` : undefined}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={onSecretKeyDown}
        />
        {src.hasCredentials ? (
          <button
            type="button"
            className="sources-clear"
            title="Clear credentials"
            onClick={onClearCredentials}
          >
            ×
          </button>
        ) : null}
      </div>
      <input
        className="sources-input"
        type="password"
        value={password}
        autoComplete="off"
        placeholder={src.hasCredentials ? '••••••••' : 'password'}
        title={
          isWindows
            ? 'Saved as encrypted Password (DPAPI, this user + this machine).'
            : 'Saved as ClearTextPassword.'
        }
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={onSecretKeyDown}
      />
      <div className="sources-field">
        <input
          className="sources-input"
          type="password"
          value={apiKey}
          autoComplete="off"
          placeholder={src.hasApiKey ? '••••••••' : 'API key'}
          title={
            isWindows
              ? 'Saved as encrypted <apikeys> (DPAPI, this user + this machine). NuGet CLI can use this key on this Windows account.'
              : 'Saved in <clearTextApiKeys> for a later Push from this extension. NuGet CLI cannot decrypt <apikeys> outside Windows.'
          }
          onChange={(e) => setApiKey(e.target.value)}
          onKeyDown={onSecretKeyDown}
        />
        {!isWindows ? (
          <button
            type="button"
            className="btn btn--secondary sources-copy"
            title="Copies the API key you just typed as export NUGET_API_KEY=… The saved key never reaches this panel."
            disabled={apiKey.length === 0}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCopyApiKeyExport(nugetApiKeyExportCommand(apiKey))}
          >
            Copy typed
          </button>
        ) : null}
        {src.hasApiKey ? (
          <button
            type="button"
            className="sources-clear"
            title="Clear API key"
            onClick={onClearApiKey}
          >
            ×
          </button>
        ) : null}
      </div>
      <div className="sources-edit__row">
        <button
          type="button"
          className="btn btn--secondary sources-save"
          disabled={!dirty}
          onClick={persistSecrets}
        >
          Save credentials
        </button>
        {showSecretsDest ? <DestHint dest={secretsDest} title={secretsTitle} /> : null}
      </div>
    </div>
  );
}

/** "+ Add source" / "+ Add audit source" affordance — collapsed button, expands to a small inline form (#48). */
function AddSourceForm({
  kind,
  targetLabel,
  disabled,
  onAdd,
}: {
  kind: RepoKind;
  targetLabel: string;
  disabled: boolean;
  onAdd: (name: string, url: string, protocolVersion?: '2' | '3') => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [v2, setV2] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const reset = () => {
    setName('');
    setUrl('');
    setV2(false);
    setOpen(false);
  };

  if (disabled) return null;

  const canSubmit = name.trim().length > 0 && url.trim().length > 0;
  const submit = () => {
    if (!canSubmit) return;
    onAdd(name.trim(), url.trim(), v2 ? '2' : undefined);
    reset();
  };

  return (
    <div className="sources-add-row">
      <button
        ref={toggleRef}
        type="button"
        className="btn sources-add-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        + Add {kind === 'audit' ? 'audit ' : ''}source
      </button>
      {open ? (
        <AnchoredPanel
          anchorRef={toggleRef}
          onClose={reset}
          title={`Add ${kind === 'audit' ? 'audit ' : ''}source`}
        >
          <div className="sources-edit">
            <div className="sources-field">
              <input
                className="sources-input"
                value={name}
                autoComplete="off"
                spellCheck={false}
                placeholder="key"
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              />
            </div>
            <div className="sources-field">
              <input
                className="sources-input"
                value={url}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://…/index.json"
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              />
            </div>
            {kind === 'package' ? (
              <label className="sources-check" title="Explicit protocolVersion=&quot;2&quot; — otherwise inferred from the URL (default v2 unless it ends in .json)">
                <input type="checkbox" checked={v2} onChange={() => setV2((v) => !v)} />
                <span>NuGet v2 (OData)</span>
              </label>
            ) : null}
            <div className="sources-edit__row">
              <button type="button" className="btn btn--secondary sources-save" disabled={!canSubmit} onClick={submit}>
                Add
              </button>
              <button type="button" className="btn btn--secondary" onClick={reset}>
                Cancel
              </button>
              <DestHint dest={targetLabel} title={`New source writes to ${targetLabel}.`} />
            </div>
          </div>
        </AnchoredPanel>
      ) : null}
    </div>
  );
}

function RepoRow({
  src,
  fileLabel,
  enableDest,
  enableTitle,
  secretsDest,
  secretsTitle,
  showEnableDest,
  showFlagsDest,
  showSecretsDest,
  canEdit,
  editing,
  onEdit,
  onCopy,
  onOpen,
  onToggle,
  onFlags,
  onSave,
  onMapping,
  onRemove,
  onAddAsAudit,
  onCopyApiKeyExport,
  onClearCredentials,
  onClearApiKey,
  isWindows,
}: {
  src: EffectiveSourceRow;
  fileLabel: string;
  enableDest: string;
  enableTitle: string;
  secretsDest: string;
  secretsTitle: string;
  showEnableDest: boolean;
  showFlagsDest: boolean;
  showSecretsDest: boolean;
  canEdit: boolean;
  editing: boolean;
  onEdit: () => void;
  onCopy: () => void;
  onOpen: () => void;
  onToggle: () => void;
  onFlags: (allowInsecureConnections: boolean, disableTlsCertificateValidation: boolean) => void;
  onSave: (username: string, password: string | undefined, apiKey: string | undefined) => void;
  onMapping?: (patterns: string[]) => void;
  /** Fully removes the declared `<add>` — package sources only (#48); audit's disable already does this. */
  onRemove?: () => void;
  /** Package row not already declared for audit — promotes it via the existing audit-enable path (#48). */
  onAddAsAudit?: () => void;
  onCopyApiKeyExport: (command: string) => void;
  onClearCredentials: () => void;
  onClearApiKey: () => void;
  isWindows: boolean;
}) {
  const [urlMenu, setUrlMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <div
      className={`pkg-row${src.enabled ? '' : ' pkg-row--off'}${editing ? ' pkg-row--selected' : ''}`}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input, a, .sources-edit')) return;
        e.preventDefault();
        onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setUrlMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="pkg-row__title">
        <span className="pkg-row__name" title="Double-click to open in editor">{src.name}</span>
        <span className="sources-badges">
          <Badge
            label={src.enabled ? 'on' : 'off'}
            title={src.enabled ? 'Enabled' : 'Disabled'}
            tone={src.enabled ? 'on' : 'off'}
          />
          {src.protocolVersion === '2' ? (
            <Badge
              label="v2"
              title="NuGet v2 (OData). Default when the URL is not *.json, or protocolVersion is 2."
              tone="off"
            />
          ) : null}
          {src.hasCredentials ? (
            <Badge
              label={src.username || 'user'}
              title={`Credentials (${src.username || 'set'})`}
              tone="set"
            />
          ) : null}
          {src.hasApiKey ? (
            <FlagIcon title="API key set"><IconKey /></FlagIcon>
          ) : null}
          {src.allowInsecureConnections ? (
            <FlagIcon title="allowInsecureConnections — HTTP is allowed">
              <IconUnlock />
            </FlagIcon>
          ) : null}
          {src.disableTlsCertificateValidation ? (
            <FlagIcon title="disableTLSCertificateValidation — TLS certificate checks are off">
              <IconNoTls />
            </FlagIcon>
          ) : null}
          {src.mappingPatterns && src.mappingPatterns.length === 0 ? (
            <Badge
              label="unmapped"
              title="packageSourceMapping is on, but this source has no patterns"
              tone="off"
            />
          ) : null}
        </span>
        {canEdit ? (
          <span className="sources-repo__actions">
            <button
              ref={editButtonRef}
              type="button"
              className={`btn btn--icon sources-repo__edit${editing ? ' sources-repo__edit--active' : ''}`}
              title={editing ? 'Close' : 'Edit'}
              aria-label={editing ? 'Close editor' : 'Edit'}
              onClick={onEdit}
            >
              <IconPencil />
            </button>
            {onRemove ? (
              <button
                ref={removeButtonRef}
                type="button"
                className="btn btn--icon sources-repo__remove"
                title={`Remove this source from ${fileLabel}`}
                aria-label="Remove this source"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmingRemove(true);
                }}
              >
                <IconTrash />
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      {confirmingRemove && onRemove ? (
        <AnchoredPanel anchorRef={removeButtonRef} onClose={() => setConfirmingRemove(false)} title="Remove source?">
          <div className="sources-edit">
            <p className="hint">
              Removes the <code>&lt;add&gt;</code> for “{src.name}” from {fileLabel}.
            </p>
            <div className="sources-edit__row">
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  onRemove();
                  setConfirmingRemove(false);
                }}
              >
                Remove
              </button>
              <button type="button" className="btn btn--secondary" onClick={() => setConfirmingRemove(false)}>
                Cancel
              </button>
            </div>
          </div>
        </AnchoredPanel>
      ) : null}
      <div className="pkg-row__meta">
        <button
          type="button"
          className="pkg-row__version sources-url"
          title={src.urlRaw && src.urlRaw !== src.url ? `Copy ${src.url}\n(from ${src.urlRaw})` : 'Copy URL'}
          onClick={onCopy}
        >
          {src.url}
        </button>
      </div>
      {urlMenu ? (
        <SourceUrlMenu
          url={src.url}
          x={urlMenu.x}
          y={urlMenu.y}
          onAddAsAudit={onAddAsAudit}
          onCopy={onCopy}
          onClose={() => setUrlMenu(null)}
        />
      ) : null}
      {src.mappingPatterns && src.mappingPatterns.length > 0 ? (
        <div className="sources-map" title={src.mappingPatterns.join('\n')}>
          {src.mappingPatterns.join(' · ')}
        </div>
      ) : null}
      {editing && (
        <AnchoredPanel anchorRef={editButtonRef} onClose={onEdit} title={`Edit — ${src.name}`}>
          <RepoEditor
            src={src}
            fileLabel={fileLabel}
            enableDest={enableDest}
            enableTitle={enableTitle}
            secretsDest={secretsDest}
            secretsTitle={secretsTitle}
            showEnableDest={showEnableDest}
            showFlagsDest={showFlagsDest}
            showSecretsDest={showSecretsDest}
            onToggle={onToggle}
            onFlags={onFlags}
            onSave={onSave}
            onMapping={onMapping}
            onCopyApiKeyExport={onCopyApiKeyExport}
            onClearCredentials={onClearCredentials}
            onClearApiKey={onClearApiKey}
            isWindows={isWindows}
          />
        </AnchoredPanel>
      )}
    </div>
  );
}

export function SourcesTab() {
  const { state, send } = useNugetManager();
  const snapshot = state.sources.snapshot;
  const configChain = asList(state.sources.configChain);
  const [selection, setSelection] = useState<Selection>({ kind: 'effective' });
  const [editing, setEditing] = useState<Editing>(null);
  const open = (filePath: string, sourceName?: string) =>
    send({ type: 'OPEN_CONFIG_FILE', filePath, sourceName });
  const copy = (text: string) => send({ type: 'COPY_TEXT', text });
  const copyApiKeyExport = (command: string) => {
    copy(command);
    send({ type: 'SHOW_TOAST', message: 'Copied export NUGET_API_KEY=…' });
  };

  useEffect(() => {
    setEditing(null);
  }, [selection]);

  useEffect(() => {
    if (!snapshot) return;
    if (selection.kind === 'effective') return;
    const known = asList(snapshot.chain).some((f) => samePath(f.filePath, selection.path))
      || asList(snapshot.extraConfigs).some((f) => samePath(f.filePath, selection.path));
    if (!known) setSelection({ kind: 'effective' });
  }, [snapshot, selection]);

  const displayByPath = useMemo(() => {
    const map = new Map<string, string>();
    if (!snapshot) return map;
    for (const file of asList(snapshot.chain)) map.set(file.filePath, file.displayPath);
    for (const file of asList(snapshot.extraConfigs)) map.set(file.filePath, file.displayPath);
    return map;
  }, [snapshot]);

  const chain = asList(snapshot?.chain);
  const extraConfigs = asList(snapshot?.extraConfigs);
  const extras = extraConfigs.filter((e) => e.role !== 'on-chain');
  const workspaceFiles = chain.filter((f) => configLayer(f) === 'workspace');
  const globalFiles = chain.filter((f) => configLayer(f) === 'global');
  const machineFiles = chain.filter((f) => configLayer(f) === 'machine');
  const selectedChainFile = selection.kind === 'file'
    ? chain.find((f) => samePath(f.filePath, selection.path))
    : undefined;
  const selectedExtraFile = selection.kind === 'file' && !selectedChainFile
    ? extras.find((f) => samePath(f.filePath, selection.path))
    : undefined;
  const repos = useMemo(() => {
    if (!snapshot) return { package: [] as EffectiveSourceRow[], audit: [] as EffectiveSourceRow[] };
    if (selection.kind === 'effective') {
      return {
        package: asList(snapshot.effectivePackageSources),
        audit: asList(snapshot.effectiveAuditSources),
      };
    }
    const fromView = {
      package: asList(selectedChainFile?.packageSources ?? selectedExtraFile?.packageSources),
      audit: asList(selectedChainFile?.auditSources ?? selectedExtraFile?.auditSources),
    };
    if (fromView.package.length > 0 || fromView.audit.length > 0) return fromView;

    const parsed = configChain.find((f) => samePath(f.filePath, selection.path));
    if (parsed) {
      const fromParsed = reposFromParsedFile(parsed);
      if (fromParsed.package.length > 0 || fromParsed.audit.length > 0) return fromParsed;
    }

    return {
      package: asList(snapshot.effectivePackageSources).filter((s) =>
        samePath(s.configFilePath, selection.path),
      ),
      audit: asList(snapshot.effectiveAuditSources).filter((s) =>
        samePath(s.configFilePath, selection.path),
      ),
    };
  }, [snapshot, selection, selectedChainFile, selectedExtraFile, configChain]);

  if (!snapshot || (chain.length === 0 && extraConfigs.length === 0)) {
    return (
      <div className="split-tab">
        <div className="empty-state">No nuget.config files found in the chain</div>
      </div>
    );
  }

  const missingAudit = snapshotNeedsSourcesWarn(snapshot);
  const showHint = missingAudit && selection.kind === 'effective';
  const headerLabel = selection.kind === 'effective'
    ? `Effective · ${scopeTitle(state.scope)}`
    : (selectedChainFile
      ? selectedChainFile.displayPath
      : selectedExtraFile?.displayPath ?? 'Config');
  const headerPath = selection.kind === 'file' ? selection.path : chain[0]?.filePath;
  const splitMachine = selection.kind === 'effective';
  const packageRepos = splitMachine
    ? repos.package.filter((s) => !isMachineConfigPath(s.configFilePath, chain))
    : repos.package;
  const machineRepos = splitMachine
    ? repos.package.filter((s) => isMachineConfigPath(s.configFilePath, chain))
    : [];

  // Where a brand-new source (or a package source promoted to audit) lands —
  // the specific file being viewed, or the nearest workspace config in
  // Effective view (#48).
  const addSourceTargetPath = selection.kind === 'file' ? selection.path : chain[0]?.filePath;
  const canAddSourceHere = !selectedChainFile?.isMachineWide && !selectedExtraFile?.isMachineWide
    && !!addSourceTargetPath;

  const sendSecrets = (
    src: EffectiveSourceRow,
    patch: {
      username?: string;
      password?: string;
      apiKey?: string;
      clearCredentials?: boolean;
      clearApiKey?: boolean;
    },
  ) => {
    send({
      type: 'SET_SOURCE_SECRETS',
      name: src.name,
      configFilePath: src.configFilePath,
      url: src.urlRaw ?? src.url,
      ...patch,
    });
  };

  const labelForPath = (path: string) => {
    const exact = displayByPath.get(path);
    if (exact) return exact;
    for (const [p, label] of displayByPath) {
      if (samePath(p, path)) return label;
    }
    return path.replace(/^.*[/\\]/, '');
  };
  const fileLabelFor = (src: EffectiveSourceRow) => labelForPath(src.configFilePath);
  const nearestLabel = chain[0]?.displayPath ?? chain[0]?.filePath ?? 'nearest nuget.config';
  const globalConfigBase = chain.find((f) => f.isGlobal)?.displayPath ?? 'NuGet.Config';
  const globalConfigLabel = `global ${globalConfigBase}`;
  const globalFilePath = chain.find((f) => f.isGlobal)?.filePath;
  const viewPath = selection.kind === 'file' ? selection.path : null;
  const enableLabelFor = (src: EffectiveSourceRow) =>
    selection.kind === 'effective' ? nearestLabel : fileLabelFor(src);
  const canEditSource = (src: EffectiveSourceRow) => {
    if (isMachineConfigPath(src.configFilePath, chain)) return false;
    if (selectedChainFile?.isMachineWide) return false;
    if (selectedExtraFile?.isMachineWide) return false;
    return true;
  };

  const secretsWritesTextFor = (src: EffectiveSourceRow) => {
    const meta = chain.find((f) => samePath(f.filePath, src.configFilePath))
      ?? extraConfigs.find((f) => samePath(f.filePath, src.configFilePath));
    const workspace = !meta || configLayer(meta) === 'workspace';
    return workspace
      ? `Credentials / API key write to ${globalConfigLabel}. A leftover workspace block is removed so it cannot override.`
      : `Credentials / API key write to ${globalConfigLabel}.`;
  };

  const auditSourceNames = new Set(repos.audit.map((s) => s.name.toLowerCase()));

  const renderRepos = (kind: RepoKind, list: EffectiveSourceRow[]) => list.map((src) => (
    <RepoRow
      key={sourceKey(kind, src.name)}
      src={src}
      fileLabel={fileLabelFor(src)}
      enableDest={
        kind === 'audit'
          ? (selection.kind === 'effective' ? globalConfigLabel : fileLabelFor(src))
          : enableLabelFor(src)
      }
      enableTitle={
        kind === 'audit'
          ? (selection.kind === 'effective'
            ? `Enable writes this <auditSources> key to ${globalConfigLabel} when inherited; otherwise to the file that already has audit sources. Does not copy the audit chain into the repo.`
            : `Enable writes <auditSources> to ${fileLabelFor(src)}.`)
          : `Enable writes disabledPackageSources to ${enableLabelFor(src)}.`
      }
      secretsDest={globalConfigLabel}
      secretsTitle={secretsWritesTextFor(src)}
      showEnableDest={destHelpNeeded(
        viewPath,
        kind === 'audit'
          ? (selection.kind === 'effective' ? globalFilePath : src.configFilePath)
          : (selection.kind === 'effective' ? chain[0]?.filePath : src.configFilePath),
      )}
      showFlagsDest={destHelpNeeded(viewPath, src.configFilePath)}
      showSecretsDest={destHelpNeeded(viewPath, globalFilePath)}
      canEdit={canEditSource(src)}
      editing={editing?.kind === kind && editing.name.toLowerCase() === src.name.toLowerCase()}
      onEdit={() => setEditing(
        editing?.kind === kind && editing.name.toLowerCase() === src.name.toLowerCase()
          ? null
          : { kind, name: src.name },
      )}
      onCopy={() => copy(src.url)}
      onCopyApiKeyExport={copyApiKeyExport}
      onOpen={() => open(src.configFilePath, src.name)}
      onToggle={() => send({
        type: 'SET_SOURCE_ENABLED',
        name: src.name,
        configFilePath: selection.kind === 'effective'
            ? (chain[0]?.filePath ?? src.configFilePath)
          : src.configFilePath,
        enabled: !src.enabled,
        kind,
        url: src.urlRaw ?? src.url,
      })}
      onFlags={(allowInsecureConnections, disableTlsCertificateValidation) => send({
        type: 'SET_SOURCE_CONNECTION_FLAGS',
        name: src.name,
        configFilePath: src.configFilePath,
        allowInsecureConnections,
        disableTlsCertificateValidation,
      })}
      // packageSourceMapping only applies to <packageSources> — NuGet never
      // consults it for <auditSources>, so don't offer a no-op editor there.
      onMapping={kind === 'package' ? (patterns) => send({
        type: 'SET_SOURCE_MAPPING',
        name: src.name,
        configFilePath: src.configFilePath,
        patterns,
      }) : undefined}
      // Package "off" is a soft <disabledPackageSources> entry, so Remove
      // needs its own REMOVE_PACKAGE_SOURCE. Audit's "off" already fully
      // removes its <add> (removeAuditSource) — Remove here is the same
      // SET_SOURCE_ENABLED{enabled:false} the toggle sends, just reachable
      // from the row actions for a consistent Edit/Remove pair (#48).
      onRemove={kind === 'package' ? () => send({
        type: 'REMOVE_PACKAGE_SOURCE',
        configFilePath: src.configFilePath,
        name: src.name,
      }) : () => send({
        type: 'SET_SOURCE_ENABLED',
        name: src.name,
        configFilePath: src.configFilePath,
        enabled: false,
        kind: 'audit',
        url: src.urlRaw ?? src.url,
      })}
      onAddAsAudit={kind === 'package' && canAddSourceHere && !auditSourceNames.has(src.name.toLowerCase())
        ? () => send({
          type: 'SET_SOURCE_ENABLED',
          name: src.name,
          configFilePath: addSourceTargetPath!,
          enabled: true,
          kind: 'audit',
          url: src.urlRaw ?? src.url,
        })
        : undefined}
      onSave={(username, password, apiKey) => {
        const credChanged = password !== undefined || username !== (src.username ?? '');
        if (!credChanged && !apiKey) return;
        sendSecrets(src, {
          ...(credChanged ? { username, password } : {}),
          ...(apiKey ? { apiKey } : {}),
        });
      }}
      onClearCredentials={() => sendSecrets(src, { username: '', clearCredentials: true })}
      onClearApiKey={() => sendSecrets(src, { clearApiKey: true })}
      isWindows={state.isWindows}
    />
  ));

  const renderChainFile = (file: (typeof snapshot.chain)[number]) => (
    <ConfigRow
      key={file.filePath}
      title={file.displayPath}
      meta={
        summarizeChanges([...asList(file.packageChanges), ...asList(file.auditChanges)])
        || 'no source changes'
      }
      warning={file.parseError ? `Could not parse: ${file.parseError}` : undefined}
      selected={selection.kind === 'file' && samePath(file.filePath, selection.path)}
      onSelect={() => setSelection({ kind: 'file', path: file.filePath })}
      onOpen={() => open(file.filePath)}
    />
  );

  return (
    <div className="split-tab sources-tab" role="region" aria-label="NuGet source configuration">
      <SplitPane
        defaultRatio={LIST_RATIO}
        splitLabel="Resize config list"
        left={
          <>
            <ConfigFilesSection title="Effective" label="Effective sources">
              <ConfigRow
                title={scopeTitle(state.scope)}
                meta=""
                warn={missingAudit}
                selected={selection.kind === 'effective'}
                onSelect={() => setSelection({ kind: 'effective' })}
              />
            </ConfigFilesSection>

            {workspaceFiles.length > 0 && (
              <ConfigFilesSection title="Workspace" count={workspaceFiles.length} label="Workspace config files">
                {workspaceFiles.map(renderChainFile)}
              </ConfigFilesSection>
            )}

            {globalFiles.length > 0 && (
              <ConfigFilesSection title="Global" count={globalFiles.length} label="Global config files">
                {globalFiles.map(renderChainFile)}
              </ConfigFilesSection>
            )}

            {machineFiles.length > 0 && (
              <ConfigFilesSection title="Machine" count={machineFiles.length} label="Machine config files">
                {machineFiles.map(renderChainFile)}
              </ConfigFilesSection>
            )}

            {(extras.length > 0 || snapshot.extraConfigsTruncated) && (
              <ConfigFilesSection
                title="Other"
                count={extras.length}
                label="Other configs"
              >
                {snapshot.extraConfigsTruncated ? (
                  <div className="sources-warn">
                    Workspace scan stopped at 200 nuget.config files. Some Other configs may be missing.
                  </div>
                ) : null}
                {extras.map((file) => (
                  <ConfigRow
                    key={file.filePath}
                    title={file.displayPath}
                    meta={extraRoleLabel(file)}
                    warning={file.parseError ? `Could not parse: ${file.parseError}` : undefined}
                    selected={selection.kind === 'file' && samePath(file.filePath, selection.path)}
                    onSelect={() => setSelection({ kind: 'file', path: file.filePath })}
                    onOpen={() => open(file.filePath)}
                  />
                ))}
              </ConfigFilesSection>
            )}
          </>
        }
        right={
          <div className="sources-repos">
            <div className="sources-repos__header">
              <span className="sources-repos__title" title={headerLabel}>{headerLabel}</span>
              {headerPath && (
                <button type="button" className="btn btn--secondary" onClick={() => open(headerPath)}>
                  Open
                </button>
              )}
            </div>

            {asList(snapshot.conflicts).length > 0 && (
              <div className="sources-warn">
                {asList(snapshot.conflicts).map((conflict, i) => (
                  <div key={`${conflict.kind}-${i}`} className="sources-warn__item">
                    <span className="sources-warn__text">⚠ {conflict.message}</span>
                    {asList(conflict.filePaths).map((fp) => (
                      <button
                        key={fp}
                        type="button"
                        className="sources-link"
                        title={fp}
                        onClick={() => setSelection({ kind: 'file', path: fp })}
                      >
                        {displayByPath.get(fp) ?? fp.replace(/^.*[/\\]/, '')}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}

            <section className="pkg-section">
              <div className="pkg-section__header">
                <span>Sources</span>
                <span>{packageRepos.length}</span>
              </div>
              <div className="pkg-section__list" aria-label="Package sources">
                {packageRepos.length === 0 ? (
                  <div className="empty-state">
                    {selectedExtraFile ? extraRoleLabel(selectedExtraFile) : 'No package sources'}
                  </div>
                ) : renderRepos('package', packageRepos)}
                {addSourceTargetPath ? (
                  <AddSourceForm
                    key={addSourceTargetPath}
                    kind="package"
                    targetLabel={labelForPath(addSourceTargetPath)}
                    disabled={!canAddSourceHere}
                    onAdd={(name, url, protocolVersion) => send({
                      type: 'ADD_PACKAGE_SOURCE',
                      configFilePath: addSourceTargetPath,
                      name,
                      url,
                      protocolVersion,
                    })}
                  />
                ) : null}
              </div>
            </section>

            <section className="pkg-section">
              <div className="pkg-section__header">
                <span>
                  Audit
                  {showHint ? (
                    <span className="tab-btn__warn" title="No working audit source"> ⚠</span>
                  ) : null}
                </span>
                <span>{repos.audit.length}</span>
              </div>
              {showHint && (
                <div className="sources-warn sources-warn--hint">
                  {state.packages.vulnHint?.message ?? AUDIT_SOURCES_HINT}
                  {(state.packages.vulnHint?.configFilePath ?? chain[0]?.filePath) && (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="sources-link"
                        onClick={() => open(
                          state.packages.vulnHint?.configFilePath ?? chain[0]!.filePath,
                        )}
                      >
                        Open nuget.config
                      </button>
                    </>
                  )}
                </div>
              )}
              <div className="pkg-section__list" aria-label="Audit sources">
                {repos.audit.length === 0 ? (
                  <div className="pkg-row pkg-row--static pkg-row--off">
                    <div className="pkg-row__title">
                      <span className="pkg-row__name">none</span>
                    </div>
                  </div>
                ) : renderRepos('audit', repos.audit)}
                {addSourceTargetPath ? (
                  <AddSourceForm
                    key={addSourceTargetPath}
                    kind="audit"
                    targetLabel={labelForPath(addSourceTargetPath)}
                    disabled={!canAddSourceHere}
                    onAdd={(name, url) => send({
                      type: 'SET_SOURCE_ENABLED',
                      name,
                      configFilePath: addSourceTargetPath,
                      enabled: true,
                      kind: 'audit',
                      url,
                    })}
                  />
                ) : null}
              </div>
            </section>

            {machineRepos.length > 0 && (
              <section className="pkg-section">
                <div className="pkg-section__header">
                  <span>Machine</span>
                  <span>{machineRepos.length}</span>
                </div>
                <div className="pkg-section__list" aria-label="Machine package sources">
                  {renderRepos('package', machineRepos)}
                </div>
              </section>
            )}
          </div>
        }
      />
    </div>
  );
}
