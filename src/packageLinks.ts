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

import type { PackageRepository } from './types';

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
 * The project's releases *list* — GitLab's own path, GitHub's for anything
 * else `isGitHost` recognises, undefined for Bitbucket, which has no such
 * page: it groups artifacts under "Downloads" instead, tied to nothing in
 * particular rather than to tags the way GitHub's and GitLab's releases are.
 * Guessing `/releases` there would 404, which is exactly the outcome #125's
 * own item 4 refuses for a per-version tag address — the same refusal
 * applies to a page style the forge does not have at all.
 *
 * Never a per-version tag address such as `/releases/tag/v1.2.3` (#125): the
 * tag style — `v1.2.3`, `1.2.3`, `pkg-1.2.3`, none at all — is the
 * publisher's own business, and a guessed one that 404s is worse than no
 * link at all. The list page, unlike a tag page, is not a guess about
 * anything version-specific — except on the one forge that has no such page.
 */
export function releasesUrlFor(link: NormalizedRepoLink): string | undefined {
  const host = link.host.toLowerCase();
  if (host.includes('bitbucket')) return undefined;
  if (host.includes('gitlab')) return `${link.url}/-/releases`;
  return `${link.url}/releases`;
}

/**
 * Exactly one `http(s)` URL and nothing else — release notes that are prose
 * are not this (#125): the band this feeds is a short list of consequences,
 * and a wall of text is what #114 deliberately kept out of it.
 */
function bareUrl(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed && /^https?:\/\/\S+$/.test(trimmed) ? trimmed : undefined;
}

export interface ReleaseNotesLink {
  label: 'Release notes' | 'Releases';
  url: string;
}

/**
 * What the "What changes" band links to for the version being considered
 * (#125): the release notes themselves when the publisher gave a bare
 * address for them, or — failing that — the project's releases list when
 * `repository` names a recognised forge. Undefined when neither exists: no
 * label ever names a document the reader cannot open.
 *
 * "Recognised" is `isGitHost`, the same check `resolvePackageLinks` already
 * uses to decide whether an unlabelled URL is a repository at all — anything
 * `normalizeRepositoryUrl` merely parses into two path segments still goes
 * through it. Without this an Azure DevOps URL
 * (`dev.azure.com/org/project/_git/repo`) would normalize into its first two
 * segments — `org/project`, not the repository at all — and still get a
 * guessed `/releases` appended to that wrong address.
 */
export function releaseNotesLinkFor(
  releaseNotes: string | undefined,
  repository: PackageRepository | undefined,
): ReleaseNotesLink | undefined {
  const notes = bareUrl(releaseNotes);
  if (notes) return { label: 'Release notes', url: notes };

  const link = repository ? normalizeRepositoryUrl(repository.url) : undefined;
  if (!link || !isGitHost(link.host)) return undefined;
  const releasesUrl = releasesUrlFor(link);
  return releasesUrl ? { label: 'Releases', url: releasesUrl } : undefined;
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
