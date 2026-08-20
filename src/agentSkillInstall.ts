import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';

export const SKILL_ID = 'dependency-breaking-changes-review';

export type SkillFamily = 'kiro' | 'claude' | 'cursor' | 'agents' | 'antigravity';

export interface SkillInstallTarget {
  id: string;
  family: SkillFamily | 'custom';
  label: string;
  destDir: string;
  detected: boolean;
  workspace?: boolean;
}

export const FAMILY_ORDER: Array<SkillFamily | 'custom'> = [
  'kiro', 'claude', 'cursor', 'agents', 'antigravity', 'custom',
];

export function bundledSkillDir(extensionPath: string): string {
  return path.join(extensionPath, 'skills', SKILL_ID);
}

export function parseFrontmatterVersion(text: string): string | undefined {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!block) return undefined;
  const ver = block[1].match(/^version:\s*["']?([^"'\r\n]+?)["']?\s*$/m);
  return ver?.[1]?.trim() || undefined;
}

const IGNORE_SKILL_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Relative posix paths → file text (CRLF normalized). `undefined` if `dir` is missing. */
export async function readSkillTree(dir: string): Promise<Map<string, string> | undefined> {
  if (!(await pathExists(dir))) return undefined;
  const files = new Map<string, string>();
  await walkSkillTree(dir, dir, files);
  return files;
}

async function walkSkillTree(root: string, dir: string, files: Map<string, string>): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_SKILL_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSkillTree(root, full, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = path.relative(root, full).split(path.sep).join('/');
    files.set(rel, normalizeNewlines(await fs.readFile(full, 'utf8')));
  }
}

export function skillTreesEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

export type SkillInstallPlan =
  | { action: 'install' }
  | { action: 'skip'; version: string }
  | {
      action: 'confirm';
      installedVersion: string;
      bundledVersion: string;
      localEdits: boolean;
      extraFiles: string[];
    };

/** Dest missing/empty → copy. Identical to bundled → skip. Anything else → ask before replacing. */
export function planSkillInstall(
  dest: Map<string, string> | undefined,
  destVersion: string | undefined,
  bundled: Map<string, string>,
  bundledVersion: string,
): SkillInstallPlan {
  if (!dest || dest.size === 0) return { action: 'install' };
  if (skillTreesEqual(dest, bundled)) {
    return { action: 'skip', version: bundledVersion };
  }
  const extraFiles = [...dest.keys()].filter((key) => !bundled.has(key)).sort();
  const installedVersion = destVersion ?? '?';
  const localEdits = extraFiles.length > 0 || installedVersion === bundledVersion;
  return {
    action: 'confirm',
    installedVersion,
    bundledVersion,
    localEdits,
    extraFiles,
  };
}

export function overwritePromptMessage(plan: Extract<SkillInstallPlan, { action: 'confirm' }>, destDir: string): string {
  const versions = `installed ${plan.installedVersion}, bundled ${plan.bundledVersion}`;
  const extra = plan.extraFiles.length === 0
    ? ''
    : ` Extra files will be deleted: ${plan.extraFiles.slice(0, 5).join(', ')}${plan.extraFiles.length > 5 ? '…' : ''}.`;
  if (plan.localEdits) {
    return `Skill at ${destDir} has local changes (${versions}). Overwrite replaces the whole folder and discards those edits.${extra}`;
  }
  return `Skill already at ${destDir} (${versions}). Overwrite replaces the whole folder; any local edits will be lost.${extra}`;
}

/** In-place Update: copy a version bump without another folder picker. Ask only when local edits exist. */
export function inPlaceUpdateDecision(plan: SkillInstallPlan): 'skip' | 'copy' | 'ask' {
  if (plan.action === 'skip') return 'skip';
  if (plan.action === 'install') return 'copy';
  return plan.localEdits ? 'ask' : 'copy';
}

export async function commandExists(bin: string): Promise<boolean> {
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
  return new Promise((resolve) => {
    const child = spawn(cmd, [bin], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve(false);
    }, 3_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function detectFamilies(opts: {
  homedir: string;
  commandExists: (name: string) => Promise<boolean>;
  dirExists: (p: string) => Promise<boolean>;
}): Promise<Set<SkillFamily>> {
  const detected = new Set<SkillFamily>();
  const [kiroBin, kiroCli, kiroDir] = await Promise.all([
    opts.commandExists('kiro'),
    opts.commandExists('kiro-cli'),
    opts.dirExists(path.join(opts.homedir, '.kiro')),
  ]);
  if (kiroBin || kiroCli || kiroDir) detected.add('kiro');

  const [claudeBin, claudeDir] = await Promise.all([
    opts.commandExists('claude'),
    opts.dirExists(path.join(opts.homedir, '.claude')),
  ]);
  if (claudeBin || claudeDir) detected.add('claude');

  const [cursorBin, cursorAgent, cursorDir] = await Promise.all([
    opts.commandExists('cursor'),
    opts.commandExists('cursor-agent'),
    opts.dirExists(path.join(opts.homedir, '.cursor')),
  ]);
  if (cursorBin || cursorAgent || cursorDir) detected.add('cursor');

  const [ampBin, agentsHome, agentsConfig] = await Promise.all([
    opts.commandExists('amp'),
    opts.dirExists(path.join(opts.homedir, '.agents')),
    opts.dirExists(path.join(opts.homedir, '.config', 'agents')),
  ]);
  if (ampBin || agentsHome || agentsConfig) detected.add('agents');

  const [agBin, agDir] = await Promise.all([
    opts.commandExists('antigravity'),
    opts.dirExists(path.join(opts.homedir, '.gemini', 'antigravity')),
  ]);
  if (agBin || agDir) detected.add('antigravity');

  return detected;
}

export function listInstallTargets(opts: {
  homedir: string;
  workspaceRoot?: string;
  detected: ReadonlySet<SkillFamily>;
}): SkillInstallTarget[] {
  const skill = SKILL_ID;
  const home = opts.homedir;
  const rows: SkillInstallTarget[] = [
    {
      id: 'kiro-user',
      family: 'kiro',
      label: 'Kiro (user)',
      destDir: path.join(home, '.kiro', 'skills', skill),
      detected: opts.detected.has('kiro'),
    },
    {
      id: 'claude-user',
      family: 'claude',
      label: 'Claude Code (user)',
      destDir: path.join(home, '.claude', 'skills', skill),
      detected: opts.detected.has('claude'),
    },
    {
      id: 'cursor-user',
      family: 'cursor',
      label: 'Cursor (user)',
      destDir: path.join(home, '.cursor', 'skills', skill),
      detected: opts.detected.has('cursor'),
    },
    {
      id: 'agents-user',
      family: 'agents',
      label: 'Agents (user)',
      destDir: path.join(home, '.agents', 'skills', skill),
      detected: opts.detected.has('agents'),
    },
    {
      id: 'antigravity-user',
      family: 'antigravity',
      label: 'Antigravity (user)',
      destDir: path.join(home, '.gemini', 'antigravity', 'skills', skill),
      detected: opts.detected.has('antigravity'),
    },
  ];

  if (opts.workspaceRoot) {
    rows.push(
      {
        id: 'kiro-workspace',
        family: 'kiro',
        label: 'Kiro (this workspace)',
        destDir: path.join(opts.workspaceRoot, '.kiro', 'skills', skill),
        detected: opts.detected.has('kiro'),
        workspace: true,
      },
      {
        id: 'claude-workspace',
        family: 'claude',
        label: 'Claude Code (this workspace)',
        destDir: path.join(opts.workspaceRoot, '.claude', 'skills', skill),
        detected: opts.detected.has('claude'),
        workspace: true,
      },
      {
        id: 'cursor-workspace',
        family: 'cursor',
        label: 'Cursor (this workspace)',
        destDir: path.join(opts.workspaceRoot, '.cursor', 'skills', skill),
        detected: opts.detected.has('cursor'),
        workspace: true,
      },
      {
        id: 'agents-workspace',
        family: 'agents',
        label: 'Agents (this workspace)',
        destDir: path.join(opts.workspaceRoot, '.agents', 'skills', skill),
        detected: opts.detected.has('agents'),
        workspace: true,
      },
    );
  }

  return sortTargets(rows);
}

export interface SkillInstallRow {
  label: string;
  destDir: string;
  version: string;
  outdated: boolean;
}

export interface SkillStatus {
  bundledVersion: string;
  detected: SkillFamily[];
  installs: SkillInstallRow[];
}

export const EMPTY_SKILL_STATUS: SkillStatus = {
  bundledVersion: '?',
  detected: [],
  installs: [],
};

export function orderedDetectedFamilies(detected: ReadonlySet<SkillFamily>): SkillFamily[] {
  return FAMILY_ORDER.filter((f): f is SkillFamily => f !== 'custom' && detected.has(f));
}

/**
 * Bundled version + detected families + dest dirs that already have SKILL.md.
 * Empty `detected` still lists installs found on disk (tab stays visible).
 */
export async function readSkillStatus(opts: {
  extensionPath: string;
  homedir?: string;
  workspaceRoot?: string;
  detectFamiliesFn?: typeof detectFamilies;
  commandExistsFn?: typeof commandExists;
  dirExistsFn?: typeof pathExists;
}): Promise<SkillStatus> {
  const src = bundledSkillDir(opts.extensionPath);
  const bundledTree = await readSkillTree(src);
  const bundledVersion = bundledTree?.has('SKILL.md')
    ? parseFrontmatterVersion(bundledTree.get('SKILL.md')!) ?? '?'
    : '?';
  const homedir = opts.homedir ?? os.homedir();
  const detected = await (opts.detectFamiliesFn ?? detectFamilies)({
    homedir,
    commandExists: opts.commandExistsFn ?? commandExists,
    dirExists: opts.dirExistsFn ?? pathExists,
  });
  const targets = listInstallTargets({
    homedir,
    workspaceRoot: opts.workspaceRoot,
    detected,
  });
  const installs: SkillInstallRow[] = [];
  for (const target of targets) {
    const destTree = await readSkillTree(target.destDir);
    if (!destTree?.has('SKILL.md')) continue;
    const version = parseFrontmatterVersion(destTree.get('SKILL.md')!) ?? '?';
    const outdated = !bundledTree
      || version !== bundledVersion
      || !skillTreesEqual(destTree, bundledTree);
    installs.push({
      label: target.label,
      destDir: target.destDir,
      version,
      outdated,
    });
  }
  return {
    bundledVersion,
    detected: orderedDetectedFamilies(detected),
    installs,
  };
}

export function sortTargets(targets: SkillInstallTarget[]): SkillInstallTarget[] {
  return [...targets].sort((a, b) => {
    if (a.detected !== b.detected) return a.detected ? -1 : 1;
    const fam = FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family);
    if (fam !== 0) return fam;
    if (!!a.workspace !== !!b.workspace) return a.workspace ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
}

/** Copy `srcDir` onto `destDir`. Temp dir + rename so a failure does not leave a half-written skill. */
export async function copySkillDir(srcDir: string, destDir: string): Promise<void> {
  const parent = path.dirname(destDir);
  await fs.mkdir(parent, { recursive: true });
  const tmp = path.join(parent, `.${path.basename(destDir)}.tmp-${process.pid}-${Date.now()}`);
  try {
    await fs.cp(srcDir, tmp, { recursive: true });
    await fs.rm(destDir, { recursive: true, force: true });
    await fs.rename(tmp, destDir);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => { /* ignore */ });
    throw err;
  }
}

export async function installAgentSkill(context: vscode.ExtensionContext): Promise<void> {
  const src = bundledSkillDir(context.extensionPath);
  const skillMd = path.join(src, 'SKILL.md');
  if (!(await pathExists(skillMd))) {
    await vscode.window.showErrorMessage(
      `AVE NuGet Manager: bundled skill not found at ${src}`,
    );
    return;
  }

  const homedir = os.homedir();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const detected = await detectFamilies({
    homedir,
    commandExists,
    dirExists: pathExists,
  });
  const targets = listInstallTargets({ homedir, workspaceRoot, detected });

  const picked = await vscode.window.showQuickPick(
    [
      ...targets.map((t) => ({
        label: t.label,
        description: t.detected ? 'detected' : undefined,
        detail: t.destDir,
        target: t,
      })),
      {
        label: 'Custom folder…',
        description: undefined,
        detail: 'Choose a directory; the skill folder is created inside it',
        target: undefined as SkillInstallTarget | undefined,
      },
    ],
    {
      title: 'NuGet: SKILL -> Install Dependency Breaking Changes Review',
      placeHolder: 'Where should SKILL.md be copied?',
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (!picked) return;

  let destDir = picked.target?.destDir;
  if (!destDir) {
    const folders = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: 'Folder that will contain the skill directory',
      openLabel: 'Install here',
    });
    const folder = folders?.[0]?.fsPath;
    if (!folder) return;
    destDir = path.join(folder, SKILL_ID);
  }

  const bundledTree = await readSkillTree(src);
  if (!bundledTree?.has('SKILL.md')) {
    await vscode.window.showErrorMessage(
      `AVE NuGet Manager: bundled skill not found at ${src}`,
    );
    return;
  }
  const bundledVersion = parseFrontmatterVersion(bundledTree.get('SKILL.md')!) ?? '?';
  const destTree = await readSkillTree(destDir);
  const destVersion = destTree?.has('SKILL.md')
    ? parseFrontmatterVersion(destTree.get('SKILL.md')!)
    : undefined;
  const plan = planSkillInstall(destTree, destVersion, bundledTree, bundledVersion);

  if (plan.action === 'skip') {
    void vscode.window.showInformationMessage(
      `Skill already up to date at ${destDir} (${plan.version}).`,
    );
    return;
  }
  if (plan.action === 'confirm') {
    const go = await vscode.window.showWarningMessage(
      overwritePromptMessage(plan, destDir),
      { modal: true },
      'Overwrite',
      'Cancel',
    );
    if (go !== 'Overwrite') return;
  }

  try {
    await copySkillDir(src, destDir);
  } catch (err) {
    await vscode.window.showErrorMessage(
      `AVE NuGet Manager: could not copy the skill (${err instanceof Error ? err.message : String(err)}).`,
    );
    return;
  }

  void vscode.window.showInformationMessage(
    `Skill installed at ${destDir}. Start a new agent session if it does not appear yet.`,
  );
}

/** Copy bundled skill onto dest dirs that already have it (Agents tab Update). No QuickPick. */
export async function updateOutdatedAgentSkills(context: vscode.ExtensionContext): Promise<void> {
  const src = bundledSkillDir(context.extensionPath);
  const bundledTree = await readSkillTree(src);
  if (!bundledTree?.has('SKILL.md')) {
    await vscode.window.showErrorMessage(
      `AVE NuGet Manager: bundled skill not found at ${src}`,
    );
    return;
  }
  const bundledVersion = parseFrontmatterVersion(bundledTree.get('SKILL.md')!) ?? '?';
  const status = await readSkillStatus({
    extensionPath: context.extensionPath,
    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });
  const destDirs = status.installs.filter((row) => row.outdated).map((row) => row.destDir);
  if (destDirs.length === 0) {
    void vscode.window.showInformationMessage('Skill is already up to date.');
    return;
  }

  const copied: string[] = [];
  for (const destDir of destDirs) {
    const destTree = await readSkillTree(destDir);
    const destVersion = destTree?.has('SKILL.md')
      ? parseFrontmatterVersion(destTree.get('SKILL.md')!)
      : undefined;
    const plan = planSkillInstall(destTree, destVersion, bundledTree, bundledVersion);
    const decision = inPlaceUpdateDecision(plan);
    if (decision === 'skip') continue;
    if (decision === 'ask' && plan.action === 'confirm') {
      const go = await vscode.window.showWarningMessage(
        overwritePromptMessage(plan, destDir),
        { modal: true },
        'Overwrite',
        'Cancel',
      );
      if (go !== 'Overwrite') continue;
    }
    try {
      await copySkillDir(src, destDir);
      copied.push(destDir);
    } catch (err) {
      await vscode.window.showErrorMessage(
        `AVE NuGet Manager: could not update the skill at ${destDir} (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  }

  if (copied.length === 1) {
    void vscode.window.showInformationMessage(
      `Skill updated at ${copied[0]}. Start a new agent session if it does not appear yet.`,
    );
    return;
  }
  if (copied.length > 1) {
    void vscode.window.showInformationMessage(
      `Skill updated in ${copied.length} locations. Start a new agent session if it does not appear yet.`,
    );
  }
}

export function registerAgentSkillCommand(
  context: vscode.ExtensionContext,
  afterInstall?: () => void | Promise<void>,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'averenium.nugetManager.installAgentSkill',
      async () => {
        await installAgentSkill(context);
        await afterInstall?.();
      },
    ),
  );
}
