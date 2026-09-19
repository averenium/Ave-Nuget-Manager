import React from 'react';
import { InstalledList } from './InstalledList';
import { ImplicitList } from './ImplicitList';
import { ScopeChooser, type ScopePickTarget } from './ScopeChooser';
import type { ScopeChoices } from '../../types';

interface Props {
  choices: ScopeChoices;
  currentPath: string | null;
  currentLabel: string;
  tight: boolean;
  /** Only the Packages tab has a package list worth dimming behind it (#113, #129). */
  showBackdrop: boolean;
  onPick: (target: ScopePickTarget) => void;
  onClose?: () => void;
}

/**
 * The chooser, plus the dimmed package-list peek behind it when there is one
 * — the one pairing both `PackagesTab` (hosting it unprompted or reopened on
 * its own tab) and `App` (reopened on every other tab) need, kept in one
 * place so the two do not drift apart (#129).
 */
export function ScopeChooserBody({
  choices, currentPath, currentLabel, tight, showBackdrop, onPick, onClose,
}: Props) {
  const chooser = (
    <ScopeChooser
      choices={choices}
      currentPath={currentPath}
      currentLabel={currentLabel}
      tight={tight}
      onPick={onPick}
      onClose={onClose}
    />
  );

  if (!showBackdrop) return chooser;

  return (
    <div className="scope-chooser-overlay">
      <div className="scope-chooser-overlay__backdrop" aria-hidden="true">
        <InstalledList />
        <ImplicitList />
      </div>
      {chooser}
    </div>
  );
}
