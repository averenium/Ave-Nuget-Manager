import React from 'react';
import { problemGroup, type ProblemDescriptor } from '../utils/packageProblems';
import { LicenseSideText } from './LicenseSideText';

interface Props {
  problems: ProblemDescriptor[];
  selectedPackageId: string;
  /** The nearest version no advisory in this list covers, offered as a one-click pick (#114). */
  nearestClean?: string;
  onSelectVia: (packageId: string) => void;
  onPickVersion: (version: string) => void;
}

/**
 * One `<li>` for a problem that actually is one — `resolved` carries no
 * tone or label, so `ProblemsBand` renders it separately rather than
 * through here.
 */
function ProblemItem({ p, selectedPackageId, onSelectVia }: {
  p: Exclude<ProblemDescriptor, { kind: 'resolved' }>;
  selectedPackageId: string;
  onSelectVia: (packageId: string) => void;
}) {
  const via = p.kind === 'vulnerability' ? p.via : undefined;
  return (
    <li className={`vuln-item vuln-item--${p.tone}${via ? ' vuln-item--via' : ''}`}>
      <span className="vuln-item__sev">{p.label}</span>
      <span className="vuln-item__body">
        {via ? (
          <>
            <button
              type="button"
              className="vuln-item__via"
              onClick={() => onSelectVia(via)}
              title={`Open ${via}`}
            >
              via {via}
            </button>
            {' · '}
          </>
        ) : null}
        {p.kind === 'vulnerability' ? (
          <>
            {p.finding.url ? (
              <a href={p.finding.url} target="_blank" rel="noopener noreferrer">
                {p.finding.id ?? p.finding.title ?? p.finding.url}
              </a>
            ) : (
              p.finding.id ?? p.finding.title ?? 'Advisory'
            )}
            {p.finding.version ? ` · ${p.finding.version}` : ''}
            {p.finding.source ? ` · ${p.finding.source}` : ''}
          </>
        ) : p.kind === 'mapping' ? (
          <>
            No <code>packageSourceMapping</code> pattern matches <strong>{selectedPackageId}</strong> — restore
            will not be able to find it.
            {' '}Mapped sources: {p.mappedSourceNames.join(', ')}.
          </>
        ) : p.kind === 'deprecation' ? (
          p.message
        ) : p.kind === 'unlisted' ? (
          <>
            <strong>{p.version}</strong> is no longer listed on its feed — it still restores from
            the cache, but a clean machine may not find it
          </>
        ) : p.kind === 'feed-advisory' ? (
          <>
            {p.url ? (
              <a href={p.url} target="_blank" rel="noopener noreferrer">
                {p.url.split('/').pop()}
              </a>
            ) : 'Advisory'}
            {' · '}the feed flags <strong>{p.version}</strong>
          </>
        ) : p.kind === 'licence' ? (
          <>
            <strong><LicenseSideText side={p.change.from} /></strong>
            {' → '}
            <strong><LicenseSideText side={p.change.to} /></strong>
            {p.change.unnamed
              ? ' — this version carries its licence as a file, which this extension cannot read. Open it before taking the update.'
              : ''}
          </>
        ) : (
          <>
            Updates are blocked for this package in this workspace. Right-click the row and choose{' '}
            <strong>Unblock updates</strong> to allow a version change.
          </>
        )}
      </span>
    </li>
  );
}

/**
 * The **Problems** band, split by subject rather than one flat list (#122).
 *
 * The band used to render a scan finding — always about the version
 * installed on disk — next to a feed advisory — always about whatever the
 * dropdown currently holds — with nothing but a trailing version number
 * telling them apart. Moving the selector left the scan row on screen
 * unchanged, so it read as a claim about the newly-picked version instead of
 * the one still on disk. Two headings say which is which up front: what is
 * installed does not move when the selector does, and what is selected is
 * this write's own prediction about a version nobody has taken yet.
 *
 * `mapping` and `blocked` are not about either — a package-wide fact has no
 * version to be installed at or selected, so they get no heading at all.
 */
export function ProblemsBand({
  problems, selectedPackageId, nearestClean, onSelectVia, onPickVersion,
}: Props) {
  if (problems.length === 0) return null;

  const installed = problems.filter((p) => problemGroup(p.kind) === 'installed');
  const selected = problems.filter((p) => problemGroup(p.kind) === 'selected');
  const general = problems.filter((p) => problemGroup(p.kind) === 'general');
  const lastFeedAdvisoryKey = [...selected].reverse().find((p) => p.kind === 'feed-advisory')?.key;

  const renderGroup = (title: string | null, group: ProblemDescriptor[]) => (
    <div className="problems-band__group">
      {title && <div className="problems-band__group-title">{title}</div>}
      <ul className="vuln-list">
        {group.map((p) => (
          <React.Fragment key={p.key}>
            {p.kind === 'resolved' ? (
              // The one positive statement this band makes (#122): the
              // picked version clears a direct, installed vulnerability.
              // No tone, no button — it is already the case, not an offer.
              <li className="problems-band__offer">
                <span aria-hidden="true">✓</span>{' '}
                <strong>{p.version}</strong> does not carry the {p.count === 1 ? 'vulnerability' : 'vulnerabilities'} installed above
              </li>
            ) : (
              <ProblemItem p={p} selectedPackageId={selectedPackageId} onSelectVia={onSelectVia} />
            )}
            {/* Kept right after the advisory it corrects, inside the same
                group, so a row printed below it (a licence change, say)
                cannot make the offer read as if it followed from that
                instead (#114). */}
            {p.key === lastFeedAdvisoryKey && nearestClean && (
              <li className="problems-band__offer">
                <span aria-hidden="true">↑</span>{' '}
                <strong>{nearestClean}</strong> is the nearest version this advisory does not cover
                {' '}
                <button
                  type="button"
                  className="problems-band__pick"
                  onClick={() => onPickVersion(nearestClean)}
                >pick it</button>
              </li>
            )}
          </React.Fragment>
        ))}
      </ul>
    </div>
  );

  return (
    <div className="problems-band">
      <div className="detail-section__title">Problems</div>
      {installed.length > 0 && renderGroup('Installed', installed)}
      {selected.length > 0 && renderGroup('Selected', selected)}
      {general.length > 0 && renderGroup(null, general)}
    </div>
  );
}
