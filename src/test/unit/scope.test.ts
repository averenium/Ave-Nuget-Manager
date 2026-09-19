import { scopeChooserRenderState } from '../../webview/utils/scope';
import type { WorkspaceScope } from '../../types';

const PROJECT_SCOPE: WorkspaceScope = { kind: 'project', projectPath: '/repo/Example.Api.csproj' };
const OTHER_TABS = ['updates', 'sources', 'log', 'agents'] as const;

describe('scopeChooserRenderState', () => {
  it('is invisible when there are no scope choices to show', () => {
    const state = scopeChooserRenderState(null, false, false, 'packages');
    expect(state.visible).toBe(false);
  });

  it('shows the unprompted chooser only as the Packages tab body while the folder is ambiguous (#113)', () => {
    const state = scopeChooserRenderState(null, true, false, 'packages');
    expect(state.visible).toBe(true);
    // Nobody pressed anything, so there is no way back to offer.
    expect(state.tight).toBe(false);
    expect(state.showBackdrop).toBe(false);
    expect(state.showCurrent).toBe(false);
  });

  it.each(OTHER_TABS)(
    'does not block the %s tab just because the folder happens to be ambiguous (#129)',
    (activeTab) => {
      const state = scopeChooserRenderState(null, true, false, activeTab);
      expect(state.visible).toBe(false);
    },
  );

  it('stays hidden with an existing scope until the corner control reopens it', () => {
    const state = scopeChooserRenderState(PROJECT_SCOPE, true, false, 'packages');
    expect(state.visible).toBe(false);
  });

  it.each(OTHER_TABS)(
    'reopens over the %s tab once the corner control is pressed there, scope already pinned (#129)',
    (activeTab) => {
      const state = scopeChooserRenderState(PROJECT_SCOPE, true, true, activeTab);
      expect(state.visible).toBe(true);
      expect(state.tight).toBe(true);
      // Only Packages has a package list behind it worth dimming.
      expect(state.showBackdrop).toBe(false);
      expect(state.showCurrent).toBe(true);
    },
  );

  it.each(OTHER_TABS)(
    'reopens over the %s tab even while the folder is still ambiguous, and stays closable (#129)',
    (activeTab) => {
      const state = scopeChooserRenderState(null, true, true, activeTab);
      expect(state.visible).toBe(true);
      // Explicitly opened, so a way back is offered even with nothing pinned
      // yet to name it after.
      expect(state.tight).toBe(true);
      expect(state.showBackdrop).toBe(false);
      expect(state.showCurrent).toBe(false);
    },
  );

  it('shows the dimmed package-list backdrop only when reopened on the Packages tab, scope pinned', () => {
    const state = scopeChooserRenderState(PROJECT_SCOPE, true, true, 'packages');
    expect(state.visible).toBe(true);
    expect(state.tight).toBe(true);
    expect(state.showBackdrop).toBe(true);
    expect(state.showCurrent).toBe(true);
  });
});
