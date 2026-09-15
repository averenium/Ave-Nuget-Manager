import React, { useEffect, useRef, useState } from 'react';
import type { DeclaredDependencyGroup } from '../../types';
import { frameworkKey, frameworkLabel } from '../../frameworkMoniker';
import { frameworkAccepts } from '../../frameworkCompatibility';
import { declaredOptions, defaultGroupFor } from '../utils/declaredGroups';

interface Props {
  /** What the selected version declares, per framework, as the feed stated it. */
  groups: DeclaredDependencyGroup[];
  /** Every framework the workspace's projects target, newest first. */
  projectFrameworks: string[];
}

/**
 * The dependencies a version *declares*, for a package that is not installed
 * (#114).
 *
 * The resolved tree needs a restore graph, and a package nothing has installed
 * has none — so until now the panel said nothing at all about what an install
 * would pull in. The registration entry states the ranges, and the version walk
 * already downloaded it.
 *
 * These are ranges rather than resolved versions, which the rows show for
 * themselves — `[3.1.0, 4.0.0)` is not a version, and the heading already says
 * "declared". A sentence explaining that competed with the rows it explained and
 * was cut. The section switches to the resolved tree the moment the package is
 * installed: the same rows with one column more, so nothing moves under the
 * reader.
 *
 * **The framework is selectable.** Answering for the group restore would take is
 * the right default and the wrong limit: a library author comparing what a
 * package pulls in on `net8.0` against `netstandard2.0` could see only one of
 * them, and a package whose group for this project is empty may declare plenty
 * elsewhere. Nothing is fetched to switch — every group came down with the
 * registration entry.
 *
 * The control is the heading's own right-hand line rather than a strip of tabs.
 * That line already named the group, so making it the picker costs no height,
 * which is the panel's scarcest dimension; and it holds a long list as easily as
 * a short one, where tabs do not — `Newtonsoft.Json` declares seven groups,
 * which fit no sidebar at any width and would need a second row, a scroller or
 * an overflow menu, each costing more than it saves.
 */
export function DeclaredDependenciesSection({ groups, projectFrameworks }: Props) {
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // The same outside-click/Escape pattern the other dropdowns use (#70).
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
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
  }, [open]);

  if (groups.length === 0) return null;
  // Empty until `dotnet list` answers, and empty for good if it failed — which
  // is exactly the state this panel exists to survive, since the list fills from
  // the feed whether or not restore works. With no framework to name, the
  // section still shows a group and says which, and claims nothing about a
  // project it cannot describe.
  const target: string | undefined = projectFrameworks[0];
  // The group restore would take, not the one that happens to spell this
  // framework: a package declaring net8.0 and netstandard2.0 serves a net10.0
  // project, and reporting "no group" about it would be a claim, and wrong.
  const fallback = defaultGroupFor(groups, target);
  // A version change replaces the groups, and the framework picked for the
  // previous one may not be among them — so the choice applies only while it
  // still names a group, and the default answers again when it does not.
  // `''` is the group that names no framework, so "nothing chosen" has to be
  // `undefined` rather than falsy — otherwise choosing the catch-all would read
  // as never having chosen anything.
  const picked = chosen === undefined
    ? undefined
    : groups.find((g) => frameworkKey(g.targetFramework) === chosen);
  const group = picked ?? fallback;
  const declaredFor = frameworkKey(group?.targetFramework);
  const defaultFor = frameworkKey(fallback?.targetFramework);
  const options = declaredOptions(groups);

  return (
    <div className="detail-section">
      <div className="dep-section__header">
        <span className="detail-section__title">Dependencies</span>
        <div className="dep-section__picker" ref={rootRef}>
          <button
            type="button"
            className="dep-section__context dep-section__context--btn"
            aria-expanded={open}
            aria-haspopup="listbox"
            onClick={() => setOpen((v) => !v)}
          >
            {group
              ? frameworkLabel(group.targetFramework) || 'any framework'
              // Only reachable with a target to name: without one the fallback
              // above always finds a group, so this can never read "undefined".
              : `no group for ${target}`}
            {/* Why this group and not another — a claim only the project's own
                framework supports, so it is absent when there is none to name,
                and dropped once a framework has been picked by hand, where the
                reader chose it and knows. */}
            {group && !picked && target && (
              <span className="dep-section__qualifier"> · what an install takes</span>
            )}
            <span className="dep-section__arrow" aria-hidden="true">▾</span>
          </button>
          {open && (
            <ul className="dep-section__menu" role="listbox">
              {options.map((option) => {
                // Selectable either way: browsing a framework this project
                // cannot take is the point of the control. Dimmed rather than
                // hidden, so the reader can see it was considered. A group that
                // names no framework applies to everything and is never dimmed.
                const usable = !target || !option.key || frameworkAccepts(target, option.key);
                const classes = [
                  'dep-section__option',
                  option.key === declaredFor ? 'dep-section__option--on' : '',
                  usable ? '' : 'dep-section__option--dim',
                ].filter(Boolean).join(' ');
                return (
                  <li key={option.key || '(any)'}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={option.key === declaredFor}
                      className={classes}
                      onClick={() => { setChosen(option.key); setOpen(false); }}
                    >
                      {option.label}
                      {option.key === defaultFor && target && (
                        <span className="dep-section__qualifier"> · what an install takes</span>
                      )}
                      {!usable && (
                        <span className="dep-section__qualifier"> · not for this project</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      {group ? (
        <div className="dep-list">
          {group.dependencies.length === 0 ? (
            // A group the feed declares empty says something a missing group
            // does not: this version needs nothing for this framework.
            <div className="dep-row dep-row--none">Declares no dependencies for this framework</div>
          ) : group.dependencies.map((dependency) => (
            <div className="dep-row" key={dependency.id}>
              <span className="dep-row__id" title={dependency.id}>{dependency.id}</span>
              <span className="dep-row__meta">
                <span className="dep-row__range">{dependency.range ?? 'any version'}</span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        /* The one finding worth stating carefully. A package may ship assets for
           a framework it declares no dependencies for, so this reports what the
           feed said and stops — it is not a verdict on compatibility, which is
           restore's to give. The picker above makes this less of a dead end than
           it was: what the feed does declare can now be opened and read, rather
           than only named. */
        <div className="dep-section__note">
          The feed declares dependency groups for{' '}
          {/* Spelled the way the project file spells them, and separated in the
              text itself — run together they read as one impossible moniker. */}
          {options.map((option, at) => (
            <React.Fragment key={option.key || '(any)'}>
              {at > 0 && ', '}
              <span className="badge badge--dim">{option.label}</span>
            </React.Fragment>
          ))}{' '}
          only. That usually means no assets for this project&rsquo;s framework — but a package
          can ship a framework it declares no dependencies for, so this says what the feed said
          and leaves the verdict to restore.
        </div>
      )}
    </div>
  );
}
