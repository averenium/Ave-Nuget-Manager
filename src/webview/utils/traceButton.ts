export interface TraceButtonState {
  mode: 'start' | 'stop' | 'saving';
  label: string;
  title: string;
  disabled: boolean;
}

/**
 * What the Log tab's trace button shows and whether pressing it can do
 * anything (#131). The controller ignores a press while it is packing, so a
 * button that is enabled in that window is one that silently does nothing —
 * the gate is stated here instead, as a disabled *Saving…*, and the enabled
 * states are only ever the ones a press can act on.
 */
export function traceButtonState(recording: boolean, packing: boolean): TraceButtonState {
  if (packing) {
    return { mode: 'saving', label: 'Saving…', title: 'The trace is being packed — a new one can start once it is saved', disabled: true };
  }
  if (recording) {
    return { mode: 'stop', label: 'Stop', title: 'Stop & save the trace zip', disabled: false };
  }
  return { mode: 'start', label: 'Trace', title: 'Start a diagnostic trace', disabled: false };
}
