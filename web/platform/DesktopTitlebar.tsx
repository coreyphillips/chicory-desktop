import React from 'react';
import type { DesktopBridge } from './desktop';

export function DesktopTitlebar({ desktop }: { desktop: DesktopBridge }) {
  const mac = desktop.platform === 'darwin';
  return <header className="desktop-titlebar" data-platform={desktop.platform}
    onDoubleClick={event => {
      if (!(event.target as HTMLElement).closest('button')) desktop.toggleMaximize();
    }}>
    <span className="desktop-titlebar-title">Chicory</span>
    {!mac && <div className="desktop-window-controls">
      <button type="button" aria-label="Minimize window" title="Minimize" onClick={() => desktop.minimize()}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" /></svg>
      </button>
      <button type="button" aria-label="Maximize or restore window" title="Maximize or restore" onClick={() => desktop.toggleMaximize()}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" /></svg>
      </button>
      <button type="button" className="desktop-window-close" aria-label="Close window" title="Close" onClick={() => desktop.close()}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m2 2 8 8m0-8-8 8" /></svg>
      </button>
    </div>}
  </header>;
}
