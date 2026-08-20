import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  SKILL_ID,
  copySkillDir,
  detectFamilies,
  listInstallTargets,
  overwritePromptMessage,
  parseFrontmatterVersion,
  planSkillInstall,
  inPlaceUpdateDecision,
  readSkillStatus,
  readSkillTree,
  skillTreesEqual,
  sortTargets,
  type SkillInstallTarget,
} from '../../agentSkillInstall';

describe('parseFrontmatterVersion', () => {
  it('reads a quoted version from YAML frontmatter', () => {
    expect(parseFrontmatterVersion(
      '---\nname: dependency-breaking-changes-review\nversion: "1.0.0"\n---\n# Hi\n',
    )).toBe('1.0.0');
  });

  it('returns undefined when frontmatter is missing', () => {
    expect(parseFrontmatterVersion('# No yaml\n')).toBeUndefined();
  });
});

describe('listInstallTargets / sortTargets', () => {
  const homedir = '/home/dev';

  it('puts detected families first and Custom is not in this list', () => {
    const rows = listInstallTargets({
      homedir,
      workspaceRoot: '/repo',
      detected: new Set(['kiro']),
    });
    expect(rows[0].family).toBe('kiro');
    expect(rows[0].detected).toBe(true);
    expect(rows.filter((r) => r.family === 'kiro').map((r) => r.id)).toEqual([
      'kiro-user',
      'kiro-workspace',
    ]);
    expect(rows.find((r) => r.family === 'cursor')?.detected).toBe(false);
    expect(rows.every((r) => r.family !== 'custom')).toBe(true);
  });

  it('adds Claude and Cursor workspace folders next to user', () => {
    const rows = listInstallTargets({
      homedir: '/home/dev',
      workspaceRoot: '/repo',
      detected: new Set(['claude', 'cursor']),
    });
    expect(rows.filter((r) => r.family === 'claude').map((r) => r.id)).toEqual([
      'claude-user',
      'claude-workspace',
    ]);
    expect(rows.find((r) => r.id === 'cursor-workspace')?.destDir).toBe(
      path.join('/repo', '.cursor', 'skills', SKILL_ID),
    );
  });

  it('omits workspace rows when there is no folder', () => {
    const rows = listInstallTargets({
      homedir,
      detected: new Set(),
    });
    expect(rows.some((r) => r.id.endsWith('-workspace'))).toBe(false);
    expect(rows.some((r) => r.id === 'cursor-user')).toBe(true);
  });

  it('sorts detected above undetected', () => {
    const rows: SkillInstallTarget[] = [
      { id: 'c', family: 'cursor', label: 'Cursor (user)', destDir: '/c', detected: false },
      { id: 'k', family: 'kiro', label: 'Kiro (user)', destDir: '/k', detected: true },
    ];
    expect(sortTargets(rows).map((r) => r.id)).toEqual(['k', 'c']);
  });

  it('uses homedir paths for user targets', () => {
    const rows = listInstallTargets({ homedir, detected: new Set() });
    const cursor = rows.find((r) => r.id === 'cursor-user');
    expect(cursor?.destDir).toBe(path.join(homedir, '.cursor', 'skills', SKILL_ID));
  });
});

describe('detectFamilies', () => {
  it('marks a family when either PATH or home folder hits', async () => {
    const detected = await detectFamilies({
      homedir: '/home/dev',
      commandExists: async (name) => name === 'claude',
      dirExists: async (p) => p.replace(/\\/g, '/').endsWith('/.kiro'),
    });
    expect([...detected].sort()).toEqual(['claude', 'kiro']);
  });

  it('treats cursor-agent and amp as CLI hits', async () => {
    const detected = await detectFamilies({
      homedir: '/home/dev',
      commandExists: async (name) => name === 'cursor-agent' || name === 'amp',
      dirExists: async () => false,
    });
    expect([...detected].sort()).toEqual(['agents', 'cursor']);
  });
});

describe('copySkillDir', () => {
  it('copies the tree and replaces an existing destination', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuget-skill-'));
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    await fs.mkdir(path.join(src, 'references'), { recursive: true });
    await fs.writeFile(path.join(src, 'SKILL.md'), '---\nversion: "1.0.0"\n---\n');
    await fs.writeFile(path.join(src, 'references', 'nuget.md'), 'nuget');
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(path.join(dest, 'SKILL.md'), 'old');

    await copySkillDir(src, dest);

    expect(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8')).toContain('1.0.0');
    expect(await fs.readFile(path.join(dest, 'references', 'nuget.md'), 'utf8')).toBe('nuget');
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('planSkillInstall / local edits', () => {
  const bundled = new Map([
    ['SKILL.md', '---\nversion: "1.0.3"\n---\nbody\n'],
    ['references/nuget.md', 'nuget'],
  ]);

  it('installs when the destination is missing or empty', () => {
    expect(planSkillInstall(undefined, undefined, bundled, '1.0.3').action).toBe('install');
    expect(planSkillInstall(new Map(), undefined, bundled, '1.0.3').action).toBe('install');
  });

  it('skips when the tree matches the bundle', () => {
    expect(planSkillInstall(new Map(bundled), '1.0.3', bundled, '1.0.3')).toEqual({
      action: 'skip',
      version: '1.0.3',
    });
  });

  it('asks before overwrite when the user edited files at the same version', () => {
    const dest = new Map(bundled);
    dest.set('SKILL.md', '---\nversion: "1.0.3"\n---\nuser tweak\n');
    const plan = planSkillInstall(dest, '1.0.3', bundled, '1.0.3');
    expect(plan).toMatchObject({ action: 'confirm', localEdits: true, installedVersion: '1.0.3' });
    expect(overwritePromptMessage(plan as Extract<typeof plan, { action: 'confirm' }>, '/dest')).toContain(
      'local changes',
    );
  });

  it('asks before overwrite when the user added extra files', () => {
    const dest = new Map(bundled);
    dest.set('notes.md', 'mine');
    const plan = planSkillInstall(dest, '1.0.3', bundled, '1.0.3');
    expect(plan).toMatchObject({
      action: 'confirm',
      localEdits: true,
      extraFiles: ['notes.md'],
    });
    expect(overwritePromptMessage(plan as Extract<typeof plan, { action: 'confirm' }>, '/dest')).toContain(
      'notes.md',
    );
  });

  it('asks on a version bump and still warns that the folder is replaced', () => {
    const dest = new Map([
      ['SKILL.md', '---\nversion: "1.0.2"\n---\nbody\n'],
      ['references/nuget.md', 'nuget'],
    ]);
    const plan = planSkillInstall(dest, '1.0.2', bundled, '1.0.3');
    expect(plan).toMatchObject({ action: 'confirm', localEdits: false, installedVersion: '1.0.2' });
    expect(overwritePromptMessage(plan as Extract<typeof plan, { action: 'confirm' }>, '/dest')).toContain(
      'any local edits will be lost',
    );
  });

  it('asks when the folder exists without SKILL.md', () => {
    const dest = new Map([['notes.md', 'mine']]);
    expect(planSkillInstall(dest, undefined, bundled, '1.0.3')).toMatchObject({
      action: 'confirm',
      localEdits: true,
      installedVersion: '?',
      extraFiles: ['notes.md'],
    });
  });

  it('in-place Update copies a version bump and only asks when there are local edits', () => {
    expect(inPlaceUpdateDecision({ action: 'skip', version: '1.0.3' })).toBe('skip');
    expect(inPlaceUpdateDecision({ action: 'install' })).toBe('copy');
    const bump = planSkillInstall(
      new Map([['SKILL.md', '---\nversion: "1.0.2"\n---\nbody\n'], ['references/nuget.md', 'nuget']]),
      '1.0.2',
      bundled,
      '1.0.3',
    );
    expect(inPlaceUpdateDecision(bump)).toBe('copy');
    const edited = planSkillInstall(
      new Map([...bundled, ['SKILL.md', '---\nversion: "1.0.3"\n---\ntweak\n']]),
      '1.0.3',
      bundled,
      '1.0.3',
    );
    expect(inPlaceUpdateDecision(edited)).toBe('ask');
  });
});

describe('readSkillTree', () => {
  it('treats CRLF and LF as the same tree', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuget-skill-tree-'));
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    await fs.mkdir(a);
    await fs.mkdir(b);
    await fs.writeFile(path.join(a, 'SKILL.md'), '---\nversion: "1"\n---\n');
    await fs.writeFile(path.join(b, 'SKILL.md'), '---\r\nversion: "1"\r\n---\r\n');
    const ta = await readSkillTree(a);
    const tb = await readSkillTree(b);
    expect(ta && tb && skillTreesEqual(ta, tb)).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('readSkillStatus', () => {
  async function writeSkill(dir: string, version: string, extra = ''): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nversion: "${version}"\n---\n${extra}`);
  }

  it('returns empty installs when nothing is copied, even if detected is empty', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuget-skill-status-'));
    const ext = path.join(root, 'ext');
    await writeSkill(path.join(ext, 'skills', SKILL_ID), '1.0.6');
    const status = await readSkillStatus({
      extensionPath: ext,
      homedir: path.join(root, 'home'),
      detectFamiliesFn: async () => new Set(),
    });
    expect(status.detected).toEqual([]);
    expect(status.bundledVersion).toBe('1.0.6');
    expect(status.installs).toEqual([]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('lists disk installs when detectFamilies is empty', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuget-skill-status-'));
    const ext = path.join(root, 'ext');
    const home = path.join(root, 'home');
    const dest = path.join(home, '.cursor', 'skills', SKILL_ID);
    await writeSkill(path.join(ext, 'skills', SKILL_ID), '1.0.6', '# bundled\n');
    await writeSkill(dest, '1.0.0', '# old\n');
    const status = await readSkillStatus({
      extensionPath: ext,
      homedir: home,
      detectFamiliesFn: async () => new Set(),
    });
    expect(status.detected).toEqual([]);
    expect(status.installs).toHaveLength(1);
    expect(status.installs[0].label).toBe('Cursor (user)');
    expect(status.installs[0].version).toBe('1.0.0');
    expect(status.installs[0].outdated).toBe(true);
    expect(status.installs[0].destDir).toBe(dest);
    await fs.rm(root, { recursive: true, force: true });
  });
});
