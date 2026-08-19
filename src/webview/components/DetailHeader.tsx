import React from 'react';

interface Props {
  name: string;
  actions: React.ReactNode;
  children?: React.ReactNode;
}

/** Name + icon actions on the first row; optional version picker below. */
export function DetailHeader({ name, actions, children }: Props) {
  return (
    <div className="detail-header">
      <div className="detail-header__row">
        <span className="detail-header__name" title={name}>{name}</span>
        <div className="detail-header__actions">{actions}</div>
      </div>
      {children}
    </div>
  );
}
