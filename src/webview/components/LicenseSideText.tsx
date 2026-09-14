import React from 'react';
import type { LicenseSide } from '../../packageLicense';
import { useNugetManager } from '../context/NugetManagerContext';

interface Props {
  side: LicenseSide;
}

/**
 * One side of a licence change, linked wherever there is something to link
 * (#89).
 *
 * Naming a licence without letting the reader open it is the worst of both:
 * the row says an obligation may have changed and then leaves them to go and
 * find the text. An SPDX identifier always resolves —
 * `licenses.nuget.org/<id>` renders every one of them. A `type="file"` licence
 * resolves only when the feed states a page for that exact version, which the
 * public feed does and a private one usually does not; without one it stays
 * plain text, which is honest, because there is genuinely nowhere to send them.
 *
 * `(file)` is spelled out rather than implied by styling: it is the difference
 * between a licence this tool can name and one only the file itself states, and
 * it has to survive a copied row and a forced-colors theme.
 */
export function LicenseSideText({ side }: Props) {
  const { send } = useNugetManager();
  const label = side.file ? `${side.text} (file)` : side.text;

  // The file on disk wins over any page: it is the exact text this project is
  // bound by, not the feed's rendering of it, and it is there for the installed
  // version whether or not the feed says anything.
  if (side.filePath) {
    return (
      <button
        type="button"
        className="licence-link licence-link--file"
        title={side.filePath}
        onClick={() => send({ type: 'OPEN_LICENSE_FILE', filePath: side.filePath! })}
      >
        {label}
      </button>
    );
  }
  if (!side.url) return <>{label}</>;
  return (
    <a href={side.url} target="_blank" rel="noopener noreferrer" className="licence-link">
      {label}
    </a>
  );
}
