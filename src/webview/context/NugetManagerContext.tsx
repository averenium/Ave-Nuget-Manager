import React, { createContext, useContext, useReducer, useCallback } from 'react';
import { compareSemVer } from '../utils/search';
import type {
  WorkspaceScope,
  InstalledPackage,
  ImplicitPackage,
  AvailablePackage,
  PackageMetadata,
  PackageSource,
  NuGetConfigFile,
  LogEntry,
} from '../../types';
import type { ExtensionMessage } from '../../messages';

/** Returns true only when latestVersion is strictly newer than installed version */
function hasUpdate(pkg: InstalledPackage): boolean {
  if (!pkg.latestVersion || !pkg.resolvedVersion) return false;
  // compareSemVer > 0 means latestVersion > resolvedVersion
  return compareSemVer(pkg.latestVersion, pkg.resolvedVersion) > 0;
}
import { sendMessage, onMessage } from '../vscodeApi';

// ─── State shape ──────────────────────────────────────────────────────────────

export interface AppState {
  scope: WorkspaceScope | null;
  activeTab: 'packages' | 'sources' | 'log';
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
  };
  sources: {
    configChain: NuGetConfigFile[];
    allSources: PackageSource[];
  };
  log: {
    entries: LogEntry[];
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
    prerelease: true,
    enrichProgress: null,
    isLoadingPackages: false,
  },
  sources: { configChain: [], allSources: [] },
  log: { entries: [] },
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
  | { type: 'SET_PROJECT_ERROR'; projectPath: string; error: string | null };

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

    case 'SET_PRERELEASE':
      return {
        ...state,
        packages: { ...state.packages, prerelease: action.prerelease },
      };

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
      action.loading ? set.add(action.projectPath) : set.delete(action.projectPath);
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
        sources: { configChain: msg.configChain, allSources: msg.sources },
        packages: {
          ...state.packages,
          // Clear lists and set loading while new scope initialises
          installed: [],
          implicit: [],
          available: [],
          isLoadingPackages: true,
          enrichProgress: null,
          selectedSources: msg.sources.filter((s) => s.enabled).map((s) => s.name),
          prerelease: msg.includePrerelease,
        },
      };

    case 'INSTALLED_PACKAGES':
      return {
        ...state,
        packages: {
          ...state.packages,
          installed: msg.packages,
          isLoadingPackages: false,
          enrichProgress: { done: 0, total: msg.packages.length },
        },
      };

    case 'ENRICH_PROGRESS': {
      const finished = msg.done >= msg.total;
      return {
        ...state,
        packages: {
          ...state.packages,
          enrichProgress: finished ? null : { done: msg.done, total: msg.total },
        },
      };
    }

    case 'PACKAGE_INFO_UPDATE': {
      // Update latestVersion + sourceName for all installed packages with this id
      const updated = state.packages.installed.map((pkg) =>
        pkg.id.toLowerCase() === msg.packageId.toLowerCase()
          ? { ...pkg, latestVersion: msg.latestVersion, sourceName: msg.sourceName }
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

    case 'ALL_VERSIONS':
      return {
        ...state,
        detail: { ...state.detail, allVersions: msg.versions },
      };

    case 'LOG_ENTRIES':
      return { ...state, log: { entries: msg.entries } };

    case 'LOG_ENTRY_ADDED':
      return { ...state, log: { entries: [...state.log.entries, msg.entry] } };

    case 'CONFIG_CHAIN_UPDATE':
      return {
        ...state,
        sources: { ...state.sources, configChain: msg.configChain },
      };

    case 'DOTNET_NOT_FOUND':
      return { ...state, dotnetMissing: true };

    case 'ERROR':
      return {
        ...state,
        detail: { ...state.detail, isLoading: false, error: msg.message },
      };

    case 'OPERATION_SUCCESS':
    case 'OPERATION_ERROR':
    case 'OPERATION_TIMEOUT':
      // Packages will refresh via INSTALLED_PACKAGES / IMPLICIT_PACKAGES messages
      return state;

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

  // Wire up incoming messages from the extension host
  React.useEffect(() => {
    const off = onMessage((msg) => dispatch({ type: 'MSG', msg }));
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
