/**
 * Repository/project link normalization for the Info panel's attribute
 * column (#86 design pass, "Links"). Nuspec `<repository url="...">` and
 * `projectUrl` are free-text fields publishers fill in by hand; both need
 * cleanup before they're safe to render as a link, and before comparing
 * them to decide whether they're actually the same destination.
 */

export interface NormalizedRepoLink {
  /** Cleaned, https, no trailing `.git`. */
  url: string;
  host: string;
  owner: string;
  repo: string;
}

/**
 * Rewrites `git://`, `git+https://`, `ssh://git@host/owner/repo` and
 * `git@host:owner/repo` into a clickable `https://host/owner/repo`, and
 * strips a trailing `.git` — otherwise a composed commit URL becomes
 * `repo.git/commit/<sha>`. Returns undefined for anything that isn't a
 * `host/owner/repo`-shaped forge URL (so a self-hosted or unusual URL falls
 * back to being shown as plain text rather than a guessed-wrong link).
 */
export function normalizeRepositoryUrl(rawUrl: string): NormalizedRepoLink | undefined {
  let url = rawUrl.trim();
  if (!url) return undefined;

  // git@host:owner/repo(.git)? (scp-like syntax)
  const scp = /^git@([^:/]+):(.+)$/.exec(url);
  if (scp) {
    url = `https://${scp[1]}/${scp[2]}`;
  } else {
    url = url
      .replace(/^git\+https?:\/\//, 'https://')
      .replace(/^git:\/\//, 'https://')
      .replace(/^ssh:\/\/git@/, 'https://')
      .replace(/^http:\/\//, 'https://');
  }
  url = url.replace(/\.git\/?$/, '');
  url = url.replace(/\/+$/, '');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
  const [owner, repo] = segments;
  return { url: `https://${parsed.host}/${owner}/${repo}`, host: parsed.host, owner, repo };
}

/** Same forge repository, written two ways (e.g. `projectUrl` and `repository.url` pointing at the same place). */
export function sameRepository(a: NormalizedRepoLink, b: NormalizedRepoLink): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase()
    && a.owner.toLowerCase() === b.owner.toLowerCase()
    && a.repo.toLowerCase() === b.repo.toLowerCase();
}

/**
 * Known redirector/landing-page domains that appear across hundreds of
 * unrelated packages' `projectUrl` (docs portals, URL shorteners) rather
 * than a project-specific site — not worth rendering as "the project link"
 * when nothing else is offered instead.
 */
const REDIRECTOR_HOSTS = new Set(['aka.ms', 'dot.net', 'asp.net', 'go.microsoft.com', 'docs.microsoft.com']);

export function isRedirectorUrl(url: string): boolean {
  try {
    return REDIRECTOR_HOSTS.has(new URL(url).host.toLowerCase());
  } catch {
    return false;
  }
}

/** `/commit/<sha>` on GitHub, `/-/commit/<sha>` on GitLab, `/commits/<sha>` on Bitbucket — falls back to GitHub's shape for an unrecognized forge. */
export function commitUrlFor(link: NormalizedRepoLink, commit: string): string {
  const host = link.host.toLowerCase();
  if (host.includes('gitlab')) return `${link.url}/-/commit/${commit}`;
  if (host.includes('bitbucket')) return `${link.url}/commits/${commit}`;
  return `${link.url}/commit/${commit}`;
}

export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * Any git hosting service, not GitHub specifically — matched on a host label
 * that starts with `git`, so `github.com`, `gitlab.com`, `gitea.io`,
 * `git.sr.ht` and a self-hosted `git.example.com` all qualify. Deliberately
 * per label rather than a substring of the whole host: `digitalocean.com`
 * contains "git" without being one. Bitbucket is named in full because it is
 * a forge whose name says nothing about git — `commitUrlFor` already knows it.
 */
export function isGitHost(host: string): boolean {
  const lower = host.toLowerCase();
  const labels = lower.split('.');
  return labels.some((label) => label.startsWith('git') || label === 'bitbucket');
}

export interface ResolvedPackageLinks {
  /** `<repository>` — the exact source the binary was built from, when present. */
  source?: { label: 'Source'; url: string; link?: NormalizedRepoLink; commit?: string };
  /** `projectUrl` — shown only when it isn't the same repo as `source` and isn't a decorative redirector. */
  project?: { label: 'Project'; url: string };
}

/**
 * One renderer for both the search response (only has `projectUrl`) and the
 * nuspec (has both `repository` and `projectUrl`, often the same place
 * written twice, or `projectUrl` pointing at a redirector/landing page).
 */
export function resolvePackageLinks(
  projectUrl: string | undefined,
  repository: { url: string; commit?: string } | undefined,
): ResolvedPackageLinks {
  const repoLink = repository ? normalizeRepositoryUrl(repository.url) : undefined;
  const source = repository
    ? { label: 'Source' as const, url: repoLink?.url ?? repository.url, link: repoLink, commit: repository.commit }
    : undefined;

  if (!projectUrl) return { source };

  const projLink = normalizeRepositoryUrl(projectUrl);
  const isSameAsSource = !!(repoLink && projLink && sameRepository(repoLink, projLink));
  const isDecorative = !projLink && isRedirectorUrl(projectUrl);
  if (isSameAsSource || isDecorative) return { source };

  // The search response carries no `<repository>`, only `projectUrl` — and for
  // most packages that URL is the repository. Calling it "Project" then hides
  // the one thing it actually is; when it points at a git host and nothing
  // better is known, it is the source.
  if (!source && projLink && isGitHost(projLink.host)) {
    return { source: { label: 'Source', url: projLink.url, link: projLink } };
  }

  return { source, project: { label: 'Project', url: projectUrl } };
}
