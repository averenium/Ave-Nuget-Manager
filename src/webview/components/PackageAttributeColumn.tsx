import React, { useLayoutEffect, useRef, useState } from 'react';
import type { PackageLicense, PackageRepository } from '../../types';
import { resolveLicenseDisplay, spdxBadgeUrl } from '../../packageLicense';
import { commitUrlFor, resolvePackageLinks, shortCommit } from '../../packageLinks';
import { IconBranch, IconCommit, IconGlobe } from '../utils/icons';
import { visibleBadgeCount } from '../utils/badgeRows';

const MAX_FRAMEWORK_ROWS = 3;

interface Props {
  license?: PackageLicense;
  licenseUrl?: string;
  projectUrl?: string;
  repository?: PackageRepository;
  supportedFrameworks?: string[];
  runtimeIdentifiers?: string[];
}

/**
 * Fixed-basis column (#86 design pass) — licence, source/project links and the
 * target frameworks are always rendered, growing the column if needed rather
 * than clipping; runtime identifiers follow, capped at two rows by CSS
 * (`.pkg-attrs__optional`'s `max-height`).
 *
 * Tags are deliberately not here. The design has this tier fill only the height
 * the description beside it already occupies, and knowing that height means
 * measuring one column against the other — a coupling that proved too brittle
 * to keep. Without it, tags are the one item whose only effect is to make the
 * column taller than its neighbour, so they are left out until that is settled.
 */
export function PackageAttributeColumn({
  license,
  licenseUrl,
  projectUrl,
  repository,
  supportedFrameworks,
  runtimeIdentifiers,
}: Props) {
  const licenseDisplay = resolveLicenseDisplay(license, licenseUrl);
  const links = resolvePackageLinks(projectUrl, repository);
  const hasFrameworks = (supportedFrameworks?.length ?? 0) > 0;
  const hasRuntimeIdentifiers = (runtimeIdentifiers?.length ?? 0) > 0;

  const frameworksProbeRef = useRef<HTMLDivElement>(null);
  const [frameworkLimit, setFrameworkLimit] = useState<number | null>(null);

  // How many frameworks survive the three-row limit. Only the widths come from
  // the DOM; the decision itself is `visibleBadgeCount`, which simulates the
  // wrap and is unit-tested. Widths are read from the probe, which always holds
  // the full list plus the `…` marker as its last child — so the measurement
  // can never depend on the decision it feeds.
  useLayoutEffect(() => {
    const probe = frameworksProbeRef.current;
    if (!probe) return;
    const measure = () => {
      const widths = [...probe.children].map((c) => c.getBoundingClientRect().width);
      const ellipsisWidth = widths.pop() ?? 0;
      const gap = parseFloat(getComputedStyle(probe).columnGap) || 0;
      setFrameworkLimit(
        visibleBadgeCount(widths, ellipsisWidth, probe.clientWidth, gap, MAX_FRAMEWORK_ROWS),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(probe);
    return () => observer.disconnect();
  }, [supportedFrameworks?.join(' ')]);

  if (
    licenseDisplay.kind === 'none' && !links.source && !links.project
    && !hasFrameworks && !hasRuntimeIdentifiers
  ) {
    return null;
  }

  return (
    <div className="pkg-attrs">
      <div className="pkg-attrs__core">
        {licenseDisplay.kind === 'expression' && (
          <div className="pkg-attrs__row">
            {licenseDisplay.ids.map((id, i) => (
              <React.Fragment key={id}>
                {i > 0 && <span className="pkg-attrs__op">{licenseDisplay.operators[i - 1].toLowerCase()}</span>}
                <a
                  className="badge"
                  href={spdxBadgeUrl(id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={licenseDisplay.fullExpression}
                >
                  {id}
                </a>
              </React.Fragment>
            ))}
          </div>
        )}
        {licenseDisplay.kind === 'file' && (
          <div className="pkg-attrs__row">
            <span className="badge" title={licenseDisplay.fileName}>License</span>
          </div>
        )}
        {licenseDisplay.kind === 'url' && (
          <div className="pkg-attrs__row">
            <a className="badge" href={licenseDisplay.url} target="_blank" rel="noopener noreferrer">License</a>
          </div>
        )}

        {links.source && (
          <div className="pkg-attrs__row">
            {/* Two destinations, so two links: the repository itself, and the
                exact revision it was built from. Composing the commit URL needs
                a recognised forge — without one the revision is still worth
                showing, just as text rather than a guessed-wrong link. */}
            <a className="pkg-attrs__link" href={links.source.url} target="_blank" rel="noopener noreferrer">
              <IconBranch /> {links.source.label}
            </a>
            {links.source.commit && (
              links.source.link ? (
                <a
                  className="pkg-attrs__link pkg-attrs__commit"
                  href={commitUrlFor(links.source.link, links.source.commit)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Commit ${links.source.commit}`}
                >
                  <IconCommit /> {shortCommit(links.source.commit)}
                </a>
              ) : (
                <span className="pkg-attrs__commit" title={links.source.commit}>
                  {shortCommit(links.source.commit)}
                </span>
              )
            )}
          </div>
        )}
        {links.project && (
          <div className="pkg-attrs__row">
            <a className="pkg-attrs__link" href={links.project.url} target="_blank" rel="noopener noreferrer">
              <IconGlobe /> {links.project.label}
            </a>
          </div>
        )}
      </div>

      {/* Target frameworks are shown in full, newest first: which frameworks a
          package supports is the answer to a question the reader is asking, and
          a clipped list answers it wrongly rather than partially. Ordering lives
          in `targetFrameworks.ts` — `net48` is not newer than `net8.0`. */}
      {supportedFrameworks && supportedFrameworks.length > 0 && (
        <>
          <div className="pkg-attrs__frameworks">
            {(frameworkLimit === null ? supportedFrameworks : supportedFrameworks.slice(0, frameworkLimit))
              .map((f) => <span key={f} className="badge badge--dim" title={f}>{f}</span>)}
            {frameworkLimit !== null && (
              <span
                className="badge badge--dim"
                title={supportedFrameworks.slice(frameworkLimit).join(', ')}
              >…</span>
            )}
          </div>
          <div
            className="pkg-attrs__frameworks pkg-attrs__frameworks--probe"
            ref={frameworksProbeRef}
            aria-hidden="true"
          >
            {supportedFrameworks.map((f) => <span key={f} className="badge badge--dim">{f}</span>)}
            <span className="badge badge--dim">…</span>
          </div>
        </>
      )}

      {hasRuntimeIdentifiers && (
        <div className="pkg-attrs__optional">
          {runtimeIdentifiers?.map((r) => <span key={r} className="badge badge--dimmer">{r}</span>)}
        </div>
      )}
    </div>
  );
}
