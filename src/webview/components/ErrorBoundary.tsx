import React from 'react';
import { reportWebviewError } from '../vscodeApi';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/** Catches render crashes so the panel is not a blank webview. */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportWebviewError('react', error, info.componentStack ?? undefined);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    const text = this.state.error.stack ?? this.state.error.message;
    return (
      <div className="error-banner error-banner--operation" role="alert">
        <div className="error-banner__head">
          <span className="error-banner__title">UI crashed</span>
          <div className="error-banner__actions">
            <button
              type="button"
              className="error-banner__link"
              onClick={() => this.setState({ error: null })}
            >
              Retry
            </button>
          </div>
        </div>
        <div className="log-entry error-banner__log">
          <pre className="log-entry__body log-entry__body--stdout">{text}</pre>
        </div>
      </div>
    );
  }
}
