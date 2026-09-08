import {
  commitUrlFor,
  isRedirectorUrl,
  normalizeRepositoryUrl,
  isGitHost,
  resolvePackageLinks,
  sameRepository,
  shortCommit,
} from '../../packageLinks';

describe('normalizeRepositoryUrl', () => {
  it('passes a clean https url through, extracting host/owner/repo', () => {
    expect(normalizeRepositoryUrl('https://github.com/DapperLib/Dapper')).toEqual({
      url: 'https://github.com/DapperLib/Dapper', host: 'github.com', owner: 'DapperLib', repo: 'Dapper',
    });
  });

  it('rewrites git:// to https (real EFCore.NamingConventions case from the issue)', () => {
    expect(normalizeRepositoryUrl('git://github.com/efcore/EFCore.NamingConventions')).toEqual({
      url: 'https://github.com/efcore/EFCore.NamingConventions', host: 'github.com', owner: 'efcore', repo: 'EFCore.NamingConventions',
    });
  });

  it('rewrites git+https:// to https', () => {
    expect(normalizeRepositoryUrl('git+https://github.com/owner/repo')?.url).toBe('https://github.com/owner/repo');
  });

  it('rewrites ssh://git@host/owner/repo', () => {
    expect(normalizeRepositoryUrl('ssh://git@github.com/owner/repo.git')).toEqual({
      url: 'https://github.com/owner/repo', host: 'github.com', owner: 'owner', repo: 'repo',
    });
  });

  it('rewrites the scp-like git@host:owner/repo form', () => {
    expect(normalizeRepositoryUrl('git@github.com:owner/repo.git')).toEqual({
      url: 'https://github.com/owner/repo', host: 'github.com', owner: 'owner', repo: 'repo',
    });
  });

  it('strips a trailing .git so a composed commit URL is not repo.git/commit/<sha>', () => {
    expect(normalizeRepositoryUrl('https://github.com/owner/repo.git')?.url).toBe('https://github.com/owner/repo');
  });

  it('returns undefined for a URL with no owner/repo path (not a forge link)', () => {
    expect(normalizeRepositoryUrl('https://example.com')).toBeUndefined();
  });

  it('returns undefined for an empty or unparsable value', () => {
    expect(normalizeRepositoryUrl('')).toBeUndefined();
    expect(normalizeRepositoryUrl('not a url')).toBeUndefined();
  });
});

describe('sameRepository', () => {
  it('matches the same repo written two different ways', () => {
    const a = normalizeRepositoryUrl('git://github.com/owner/repo.git')!;
    const b = normalizeRepositoryUrl('https://github.com/owner/repo')!;
    expect(sameRepository(a, b)).toBe(true);
  });

  it('does not match a different repo', () => {
    const a = normalizeRepositoryUrl('https://github.com/owner/repo')!;
    const b = normalizeRepositoryUrl('https://github.com/owner/other')!;
    expect(sameRepository(a, b)).toBe(false);
  });
});

describe('isRedirectorUrl', () => {
  it('flags known Microsoft redirector/landing domains', () => {
    expect(isRedirectorUrl('https://aka.ms/deprecateLicenseUrl')).toBe(true);
    expect(isRedirectorUrl('https://dot.net')).toBe(true);
  });

  it('does not flag a real per-project site', () => {
    expect(isRedirectorUrl('https://opentelemetry.io')).toBe(false);
  });
});

describe('commitUrlFor', () => {
  it('composes /commit/<sha> for GitHub', () => {
    const link = normalizeRepositoryUrl('https://github.com/owner/repo')!;
    expect(commitUrlFor(link, 'abc123')).toBe('https://github.com/owner/repo/commit/abc123');
  });

  it('composes /-/commit/<sha> for GitLab', () => {
    const link = normalizeRepositoryUrl('https://gitlab.com/owner/repo')!;
    expect(commitUrlFor(link, 'abc123')).toBe('https://gitlab.com/owner/repo/-/commit/abc123');
  });

  it('composes /commits/<sha> for Bitbucket', () => {
    const link = normalizeRepositoryUrl('https://bitbucket.org/owner/repo')!;
    expect(commitUrlFor(link, 'abc123')).toBe('https://bitbucket.org/owner/repo/commits/abc123');
  });
});

describe('shortCommit', () => {
  it('takes the first 7 characters', () => {
    expect(shortCommit('2a837ad7d036671ac9a75c9945bb970aa41b7de9')).toBe('2a837ad');
  });
});

describe('isGitHost', () => {
  it('matches a host label starting with git, on any forge', () => {
    for (const host of ['github.com', 'gitlab.com', 'gitea.io', 'git.sr.ht', 'git.example.com', 'GitHub.com']) {
      expect(isGitHost(host)).toBe(true);
    }
  });

  it('does not match a host that merely contains the letters', () => {
    for (const host of ['digitalocean.com', 'legitimate.dev', 'serilog.net', 'opentelemetry.io']) {
      expect(isGitHost(host)).toBe(false);
    }
  });
});

describe('resolvePackageLinks', () => {
  it('renders both Source and Project when they point at different places', () => {
    const links = resolvePackageLinks('https://opentelemetry.io', { url: 'https://github.com/open-telemetry/opentelemetry-dotnet' });
    expect(links.source?.url).toBe('https://github.com/open-telemetry/opentelemetry-dotnet');
    expect(links.project).toEqual({ label: 'Project', url: 'https://opentelemetry.io' });
  });

  it('drops Project when it is the same repository as Source written two ways (189/1001 packages case)', () => {
    const links = resolvePackageLinks('git://github.com/DapperLib/Dapper.git', { url: 'https://github.com/DapperLib/Dapper' });
    expect(links.source?.url).toBe('https://github.com/DapperLib/Dapper');
    expect(links.project).toBeUndefined();
  });

  it('drops a decorative redirector Project when there is no better link (aka.ms/dot.net case)', () => {
    const links = resolvePackageLinks('https://dot.net', undefined);
    expect(links.project).toBeUndefined();
    expect(links.source).toBeUndefined();
  });

  it('keeps a real per-project site even with no repository present', () => {
    const links = resolvePackageLinks('https://serilog.net', undefined);
    expect(links.project).toEqual({ label: 'Project', url: 'https://serilog.net' });
  });

  it('calls a projectUrl on a git host Source, not Project (the search response has no <repository>)', () => {
    const links = resolvePackageLinks('https://github.com/elastic/elasticsearch-net', undefined);
    expect(links.source).toEqual({
      label: 'Source',
      url: 'https://github.com/elastic/elasticsearch-net',
      link: { url: 'https://github.com/elastic/elasticsearch-net', host: 'github.com', owner: 'elastic', repo: 'elasticsearch-net' },
    });
    expect(links.project).toBeUndefined();
  });

  it('does the same for any git host, not just GitHub', () => {
    for (const url of [
      'https://gitlab.com/owner/repo',
      'https://gitea.io/owner/repo',
      'https://git.sr.ht/owner/repo',
      'https://git.example.com/owner/repo',
    ]) {
      expect(resolvePackageLinks(url, undefined).source?.label).toBe('Source');
    }
  });

  it('keeps a repository-declared Source rather than relabelling a different projectUrl', () => {
    const links = resolvePackageLinks('https://github.com/other/site', { url: 'https://github.com/owner/repo' });
    expect(links.source?.url).toBe('https://github.com/owner/repo');
    expect(links.project).toEqual({ label: 'Project', url: 'https://github.com/other/site' });
  });

  it('carries the commit through on the Source link', () => {
    const links = resolvePackageLinks(undefined, { url: 'https://github.com/owner/repo', commit: 'abc123' });
    expect(links.source?.commit).toBe('abc123');
  });
});
