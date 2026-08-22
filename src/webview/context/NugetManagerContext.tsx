import React, { createContext, useContext, useReducer, useCallback } from 'react';
import { compareSemVer } from '../../semver';
import { fileNameNoExt } from '../utils/pathUtils';
import { pathsEqual, packageIdsEqual } from '../../pathCompare';
import { formatBatchUpdateError, preserveInstalledEnrichment } from '../../batchUpdates';
import type {
  WorkspaceScope,
  InstalledPackage,
  ImplicitPackage,
  AvailablePackage,
  PackageMetadata,
  PackageSource,
  NuGetConfigFile,
  LogEntry,
  OperationFailure,
  BatchUpdateJob,
  VulnerabilityFinding,
} from '../../types';
import type { SkillFamily, SkillInstallRow } from '../../agentSkillInstall';
import type { ExtensionMessage } from '../../messages';
import { sendMessage, onMessage, getPersistedState, patchPersistedState } from '../vscodeApi';
import type { RoslynCap } from '../../roslynSdkCap';

/** Returns true only when latestVersion is strictly newer than installed version */
function hasUpdate(pkg: InstalledPackage): boolean {
  if (!pkg.latestVersion || !pkg.resolvedVersion) return false;
  return compareSemVer(pkg.latestVersion, pkg.resolvedVersion) > 0;
}

function formatOperationError(msg: {
  operation: 'install' | 'remove';
  packageId: string;
  failures: OperationFailure[];
  rollbackApplied?: boolean;
  canRollback?: boolean;
}): string {
  const verb = msg.operation === 'install' ? 'Install/update' : 'Remove';
  const header = `${verb} of ${msg.packageId} failed`;
  const rollbackNote = msg.rollbackApplied
    ? 'PackageReference was rolled back to the previous version.'
    : msg.canRollback
      ? 'Project file still has the new version. Use Rollback to restore the previous PackageReference.'
      : null;
  const blocks = msg.failures.map((f) => {
    const name = fileNameNoExt(f.projectPath);
    return `${name}:\n${f.stderr}`;
  });
  return [header, rollbackNote, ...blocks].filter(Boolean).join('\n\n');
}

function withoutLoading(set: Set<string>, paths: string[]): Set<string> {
  const next = new Set(set);
  for (const existing of set) {
    if (paths.some((p) => pathsEqual(existing, p))) next.delete(existing);
  }
  return next;
}

function withoutPaths(errors: Record<string, string>, paths: string[]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors).filter(([k]) => !paths.some((p) => pathsEqual(k, p))),
  );
}

function setProjectVersion(
  versions: Record<string, string>,
  projectPath: string,
  version: string,
): Record<string, string> {
  const existing = Object.keys(versions).find((k) => pathsEqual(k, projectPath));
  return { ...versions, [existing ?? projectPath]: version };
}

export interface AppState {
  scope: WorkspaceScope | null;
  activeTab: 'packages' | 'sources' | 'updates' | 'log' | 'agents';
  packages: {
    installed: InstalledPackage[];
    implicit: ImplicitPackage[];
    available: AvailablePackage[];
    searchQuery: string;
    selectedSources: string[];
    isSearching: boolean;
    prerelease: boolean;
    enrichProgress: { done: number; total: number } | null;
    /** True while dotnet list commands are in flight (before INSTALLED_PACKAGES arrives) */
    isLoadingPackages: boolean;
    vulnerabilities: VulnerabilityFinding[];
    blockedPackages: string[];
    vulnHint: {
      show: boolean;
      fingerprint: string;
      message: string;
      configFilePath?: string;
    } | null;
    vulnHintDismissedFingerprint: string | null;
  };
  sources: {
    configChain: NuGetConfigFile[];
    allSources: PackageSource[];
  };
  log: {
    entries: LogEntry[];
  };
  agents: {
    bundledVersion: string;
    detected: SkillFamily[];
    installs: SkillInstallRow[];
  };
  updates: {
    jobs: BatchUpdateJob[];
    activeJobId: string | null;
    versionsByPackageId: Record<string, string[]>;
  };
  detail: {
    selectedPackageId: string | null;
    metadata: PackageMetadata | null;
    allVersions: string[];
    isLoading: boolean;
    error: string | null;
    projectVersions: Record<string, string>;
    projectErrors: Record<string, string>;
    projectLoadingSet: Set<string>;
  };
  dotnetMissing: boolean;
  globalError: string | null;
  pendingRollback: boolean;
  workspaceActivity: { kind: 'restore' | 'refresh'; phase: 'work' | 'enrich' } | null;
  traceRecording: boolean;
  roslynCap: RoslynCap | null;
}

const initialState: AppState = {
  scope: null,
  activeTab: 'packages',
  packages: {
    installed: [],
    implicit: [],
    available: [],
    searchQuery: '',
    selectedSources: [],
    isSearching: false,
    prerelease: false,
    enrichProgress: null,
    isLoadingPackages: false,
    vulnerabilities: [],
    blockedPackages: [],
    vulnHint: null,
    vulnHintDismissedFingerprint: getPersistedState().vulnHintDismissedFingerprint ?? null,
  },
  sources: { configChain: [], allSources: [] },
  log: { entries: [] },
  agents: { bundledVersion: '?', detected: [], installs: [] },
  updates: { jobs: [], activeJobId: null, versionsByPackageId: {} },
  detail: {
    selectedPackageId: null,
    metadata: null,
    allVersions: [],
    isLoading: false,
    error: null,
    projectVersions: {},
    projectErrors: {},
    projectLoadingSet: new Set(),
  },
  dotnetMissing: false,
  globalError: null,
  pendingRollback: false,
  workspaceActivity: null,
  traceRecording: false,
  roslynCap: null,
};

// ─── Actions ──────────────────────────────────────────────────────────────────

export type Action =
  | { type: 'SET_TAB'; tab: AppState['activeTab'] }
  | { type: 'MSG'; msg: ExtensionMessage }
  | { type: 'SET_SEARCH_QUERY'; query: string }
  | { type: 'SET_SELECTED_SOURCES'; sources: string[] }
  | { type: 'SET_PRERELEASE'; prerelease: boolean }
  | { type: 'SELECT_PACKAGE'; packageId: string }
  | { type: 'SET_DETAIL_LOADING'; loading: boolean }
  | { type: 'SET_PROJECT_VERSION'; projectPath: string; version: string }
  | { type: 'SET_PROJECT_LOADING'; projectPath: string; loading: boolean }
  | { type: 'SET_PROJECT_ERROR'; projectPath: string; error: string | null }
  | { type: 'DISMISS_GLOBAL_ERROR' }
  | { type: 'DISMISS_VULN_HINT' };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_TAB':
      return { ...state, activeTab: action.tab };

    case 'SET_SEARCH_QUERY':
      return {
        ...state,
        packages: { ...state.packages, searchQuery: action.query },
      };

    case 'SET_SELECTED_SOURCES':
      return {
        ...state,
        packages: { ...state.packages, selectedSources: action.sources },
      };

    case 'SET_PRERELEASE': {
      const installed = state.packages.installed.map((pkg) => ({
        ...pkg,
        latestVersion: undefined,
        versions: undefined,
      }));
      const unique = new Set(installed.map((pkg) => pkg.id.toLowerCase())).size;
      return {
        ...state,
        packages: {
          ...state.packages,
          prerelease: action.prerelease,
          installed,
          enrichProgress: unique > 0 ? { done: 0, total: unique } : null,
        },
        updates: { ...state.updates, versionsByPackageId: {} },
      };
    }

    case 'SELECT_PACKAGE':
      return {
        ...state,
        detail: {
          ...state.detail,
          selectedPackageId: action.packageId,
          metadata: null,
          allVersions: [],
          isLoading: true,
          error: null,
          projectVersions: {},
          projectErrors: {},
          projectLoadingSet: new Set(),
        },
      };

    case 'SET_DETAIL_LOADING':
      return { ...state, detail: { ...state.detail, isLoading: action.loading } };

    case 'SET_PROJECT_VERSION':
      return {
        ...state,
        detail: {
          ...state.detail,
          projectVersions: {
            ...state.detail.projectVersions,
            [action.projectPath]: action.version,
          },
        },
      };

    case 'SET_PROJECT_LOADING': {
      const set = new Set(state.detail.projectLoadingSet);
      if (action.loading) {
        set.add(action.projectPath);
        return {
          ...state,
          globalError: null,
          detail: { ...state.detail, projectLoadingSet: set },
        };
      }
      set.delete(action.projectPath);
      return { ...state, detail: { ...state.detail, projectLoadingSet: set } };
    }

    case 'SET_PROJECT_ERROR':
      return {
        ...state,
        detail: {
          ...state.detail,
          projectErrors: action.error === null
            ? Object.fromEntries(
                Object.entries(state.detail.projectErrors).filter(([k]) => k !== action.projectPath),
              )
            : { ...state.detail.projectErrors, [action.projectPath]: action.error },
        },
      };

    case 'DISMISS_GLOBAL_ERROR':
      return { ...state, globalError: null };

    case 'DISMISS_VULN_HINT': {
      const fp = state.packages.vulnHint?.fingerprint ?? state.packages.vulnHintDismissedFingerprint;
      patchPersistedState({ vulnHintDismissedFingerprint: fp });
      return {
        ...state,
        packages: {
          ...state.packages,
          vulnHintDismissedFingerprint: fp,
        },
      };
    }

    case 'MSG':
      return applyExtensionMessage(state, action.msg);

    default:
      return state;
  }
}

function applyExtensionMessage(state: AppState, msg: ExtensionMessage): AppState {
  switch (msg.type) {
    case 'INIT_STATE':
      return {
        ...state,
        scope: msg.scope,
        globalError: null,
        pendingRollback: false,
        sources: { configChain: msg.configChain, allSources: msg.sources },
        packages: {
          ...state.packages,
          // Clear lists and set loading while new scope initialises
          installed: [],
          implicit: [],
          available: [],
          isLoadingPackages: true,
          enrichProgress: null,
          vulnerabilities: [],
          blockedPackages: msg.blockedPackages,
          selectedSources: msg.sources.filter((s) => s.enabled).map((s) => s.name),
          prerelease: msg.includePrerelease,
          vulnHint: null,
          vulnHintDismissedFingerprint: state.packages.vulnHintDismissedFingerprint,
        },
        updates: { ...state.updates, versionsByPackageId: {} },
        workspaceActivity: null,
        traceRecording: !!msg.traceRecording,
        agents: {
          bundledVersion: msg.bundledVersion,
          detected: msg.detected,
          installs: msg.installs,
        },
        roslynCap: msg.roslynCap,
      };

    case 'INSTALLED_PACKAGES': {
      let projectVersions = state.detail.projectVersions;
      if (state.detail.selectedPackageId) {
        for (const pkg of msg.packages) {
          if (packageIdsEqual(pkg.id, state.detail.selectedPackageId)) {
            projectVersions = setProjectVersion(projectVersions, pkg.projectPath, pkg.resolvedVersion);
          }
        }
      }
      const installed = preserveInstalledEnrichment(msg.packages, state.packages.installed);
      const uniqueIds = new Set(installed.map((pkg) => pkg.id.toLowerCase()));
      const withLatest = new Set(
        installed.filter((pkg) => pkg.latestVersion).map((pkg) => pkg.id.toLowerCase()),
      );
      return {
        ...state,
        packages: {
          ...state.packages,
          installed,
          isLoadingPackages: false,
          enrichProgress: uniqueIds.size === 0 || withLatest.size >= uniqueIds.size
            ? null
            : { done: withLatest.size, total: uniqueIds.size },
        },
        detail: { ...state.detail, projectVersions },
      };
    }

    case 'ENRICH_PROGRESS': {
      const finished = msg.done >= msg.total;
      return {
        ...state,
        packages: {
          ...state.packages,
          enrichProgress: finished ? null : { done: msg.done, total: msg.total },
        },
        workspaceActivity: finished && state.workspaceActivity?.phase === 'enrich'
          ? null
          : state.workspaceActivity,
      };
    }

    case 'VULNERABILITIES':
      return {
        ...state,
        packages: { ...state.packages, vulnerabilities: msg.findings },
      };

    case 'VULN_SCAN_HINT':
      return {
        ...state,
        packages: {
          ...state.packages,
          vulnHint: {
            show: msg.show,
            fingerprint: msg.fingerprint,
            message: msg.message,
            configFilePath: msg.configFilePath,
          },
        },
      };

    case 'BLOCKED_PACKAGES':
      return {
        ...state,
        packages: { ...state.packages, blockedPackages: msg.packageIds },
      };

    case 'PACKAGE_INFO_UPDATE': {
      // Update latestVersion + sourceName for all installed packages with this id
      const updated = state.packages.installed.map((pkg) =>
        pkg.id.toLowerCase() === msg.packageId.toLowerCase()
          ? {
            ...pkg,
            latestVersion: msg.latestVersion,
            sourceName: msg.sourceName,
            versions: msg.versions ?? pkg.versions,
          }
          : pkg,
      );
      // Sort: packages with available update (latestVersion > resolvedVersion) first
      const sorted = [...updated].sort((a, b) => {
        const aHasUpdate = hasUpdate(a);
        const bHasUpdate = hasUpdate(b);
        if (aHasUpdate && !bHasUpdate) return -1;
        if (!aHasUpdate && bHasUpdate) return 1;
        return a.id.localeCompare(b.id);
      });
      return { ...state, packages: { ...state.packages, installed: sorted } };
    }

    case 'IMPLICIT_PACKAGES':
      return { ...state, packages: { ...state.packages, implicit: msg.packages } };

    case 'INSTALLED_PACKAGES_PATCH': {
      let installed = [...state.packages.installed];
      for (const patch of msg.packages) {
        let found = false;
        installed = installed.map((pkg) => {
          if (packageIdsEqual(pkg.id, patch.id) && pathsEqual(pkg.projectPath, patch.projectPath)) {
            found = true;
            return {
              ...pkg,
              requestedVersion: patch.requestedVersion,
              resolvedVersion: patch.resolvedVersion,
            };
          }
          return pkg;
        });
        if (!found) installed.push(patch);
      }
      let projectVersions = state.detail.projectVersions;
      if (state.detail.selectedPackageId) {
        for (const patch of msg.packages) {
          if (packageIdsEqual(patch.id, state.detail.selectedPackageId)) {
            projectVersions = setProjectVersion(projectVersions, patch.projectPath, patch.resolvedVersion);
          }
        }
      }
      return {
        ...state,
        packages: { ...state.packages, installed, isLoadingPackages: false },
        detail: { ...state.detail, projectVersions },
      };
    }

    case 'SEARCH_RESULTS':
      return {
        ...state,
        packages: { ...state.packages, available: msg.packages, isSearching: false },
      };

    case 'PACKAGE_METADATA':
      return {
        ...state,
        detail: { ...state.detail, metadata: msg.metadata, isLoading: false, error: null },
      };

    case 'ALL_VERSIONS': {
      const key = msg.packageId.toLowerCase();
      const selected = state.detail.selectedPackageId;
      const matchesDetail = !!selected && packageIdsEqual(selected, msg.packageId);
      return {
        ...state,
        updates: {
          ...state.updates,
          versionsByPackageId: {
            ...state.updates.versionsByPackageId,
            [key]: msg.versions,
          },
        },
        detail: !selected || matchesDetail
          ? { ...state.detail, allVersions: msg.versions }
          : state.detail,
      };
    }

    case 'LOG_ENTRIES':
      return { ...state, log: { entries: msg.entries } };

    case 'LOG_ENTRY_ADDED':
      return { ...state, log: { entries: [...state.log.entries, msg.entry] } };

    case 'LOG_CLEARED':
      return { ...state, log: { entries: [] } };

    case 'TRACE_STATE':
      return { ...state, traceRecording: msg.recording };

    case 'SKILL_STATUS':
      return {
        ...state,
        agents: {
          bundledVersion: msg.bundledVersion,
          detected: msg.detected,
          installs: msg.installs,
        },
      };

    case 'CONFIG_CHAIN_UPDATE':
      return {
        ...state,
        sources: { ...state.sources, configChain: msg.configChain },
      };

    case 'DOTNET_NOT_FOUND':
      return { ...state, dotnetMissing: true };

    case 'ERROR': {
      const text = [msg.message, msg.details].filter(Boolean).join('\n');
      const isListRefresh = msg.message === 'Failed to refresh package list';
      const isRestore = msg.message === 'Restore failed';
      if (isRestore) {
        return {
          ...state,
          globalError: state.pendingRollback || state.globalError ? state.globalError : text,
          packages: { ...state.packages, isLoadingPackages: false },
        };
      }
      return {
        ...state,
        globalError: isListRefresh ? (state.globalError ?? text) : state.globalError,
        packages: { ...state.packages, isLoadingPackages: false },
        detail: {
          ...state.detail,
          isLoading: false,
          error: isListRefresh || isRestore ? state.detail.error : text,
        },
      };
    }

    case 'OPERATION_SUCCESS':
      return {
        ...state,
        globalError: null,
        pendingRollback: false,
        packages: { ...state.packages, isLoadingPackages: false },
        detail: {
          ...state.detail,
          projectErrors: withoutPaths(state.detail.projectErrors, msg.affectedProjects),
          projectLoadingSet: withoutLoading(state.detail.projectLoadingSet, msg.affectedProjects),
        },
      };

    case 'OPERATION_ERROR': {
      const affected = [
        ...msg.failures.map((f) => f.projectPath),
        ...msg.succeededProjects,
      ];
      const projectErrors = { ...state.detail.projectErrors };
      for (const f of msg.failures) {
        projectErrors[f.projectPath] = f.stderr;
      }
      return {
        ...state,
        globalError: formatOperationError(msg),
        pendingRollback: msg.canRollback === true,
        packages: { ...state.packages, isLoadingPackages: false },
        detail: {
          ...state.detail,
          projectErrors,
          projectLoadingSet: withoutLoading(state.detail.projectLoadingSet, affected),
        },
      };
    }

    case 'ROLLBACK_COMPLETE':
      return {
        ...state,
        globalError: null,
        pendingRollback: false,
        packages: { ...state.packages, isLoadingPackages: false },
        detail: { ...state.detail, projectLoadingSet: new Set(), projectErrors: {} },
      };

    case 'OPERATION_TIMEOUT':
      return {
        ...state,
        globalError: `Operation timed out:\n${msg.command}`,
        packages: { ...state.packages, isLoadingPackages: false },
        detail: { ...state.detail, projectLoadingSet: new Set() },
      };

    case 'BATCH_UPDATE_STARTED':
      return {
        ...state,
        activeTab: 'updates',
        globalError: null,
        updates: {
          ...state.updates,
          activeJobId: msg.job.id,
          jobs: [msg.job, ...state.updates.jobs].slice(0, 10),
        },
      };

    case 'BATCH_UPDATE_ITEM':
      return {
        ...state,
        updates: {
          ...state.updates,
          jobs: state.updates.jobs.map((job) => {
            if (job.id !== msg.jobId) return job;
            return {
              ...job,
              items: job.items.map((item) =>
                item.packageId === msg.packageId
                  ? {
                      ...item,
                      status: msg.status,
                      succeededProjects: msg.succeededProjects,
                      completedProjects: msg.completedProjects ?? msg.succeededProjects,
                      error: msg.error,
                    }
                  : item,
              ),
            };
          }),
        },
      };

    case 'BATCH_UPDATE_FINISHED': {
      const jobs = state.updates.jobs.map((job) =>
        job.id === msg.jobId ? { ...job, finishedAt: Date.now() } : job,
      );
      const job = jobs.find((j) => j.id === msg.jobId);
      const dump = job ? formatBatchUpdateError(job.items, msg.canRollback) : null;
      return {
        ...state,
        pendingRollback: msg.canRollback === true,
        globalError: dump ?? (msg.cancelled ? null : state.globalError),
        updates: { ...state.updates, jobs },
      };
    }

    case 'REFRESH_STARTED':
      return {
        ...state,
        globalError: null,
        pendingRollback: false,
        workspaceActivity: { kind: msg.kind, phase: 'work' },
        updates: {
          ...state.updates,
          jobs: state.updates.jobs.map((job) => (
            job.finishedAt ? { ...job, stale: true } : job
          )),
        },
      };

    case 'REFRESH_FINISHED': {
      const keepEnrich = state.workspaceActivity?.kind === 'refresh' && !!state.packages.enrichProgress;
      return {
        ...state,
        workspaceActivity: keepEnrich
          ? { kind: 'refresh', phase: 'enrich' }
          : null,
      };
    }

    case 'ROSLYN_CAP':
      return { ...state, roslynCap: msg.cap };

    default:
      return state;
  }
}

// ─── Context ──────────────────────────────────────────────────────────────────

interface NugetManagerContextValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  send: (msg: import('../../messages').WebviewMessage) => void;
}

const NugetManagerContext = createContext<NugetManagerContextValue | null>(null);

export function NugetManagerProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const dispatchRef = React.useRef(dispatch);
  dispatchRef.current = dispatch;

  // Subscribe before WEBVIEW_READY so INIT_STATE is not lost.
  React.useEffect(() => {
    const off = onMessage((msg) => dispatchRef.current({ type: 'MSG', msg }));
    const w = window as Window & { __nugetWebviewReady?: boolean };
    if (!w.__nugetWebviewReady) {
      w.__nugetWebviewReady = true;
      sendMessage({ type: 'WEBVIEW_READY' });
    }
    return off;
  }, []);

  const send = useCallback(
    (msg: import('../../messages').WebviewMessage) => sendMessage(msg),
    [],
  );

  return (
    <NugetManagerContext.Provider value={{ state, dispatch, send }}>
      {children}
    </NugetManagerContext.Provider>
  );
}

export function useNugetManager(): NugetManagerContextValue {
  const ctx = useContext(NugetManagerContext);
  if (!ctx) throw new Error('useNugetManager must be used inside NugetManagerProvider');
  return ctx;
}
