import { Buffer } from 'buffer';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './chicory/App';
import './style.css';
import { DesktopTitlebar } from './platform/DesktopTitlebar';
import './platform/desktop';

Object.assign(globalThis, { Buffer });
const demo = new URLSearchParams(location.search).has('demo');
document.documentElement.dataset.demo = String(demo);
const desktop = window.chicoryDesktop;
document.documentElement.dataset.nativeDesktop = String(!!desktop);

class AppBoundary extends React.Component<React.PropsWithChildren, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : 'Chicory could not open.' };
  }
  render() {
    if (this.state.error) return <main className="startup-error"><h1>Chicory could not open</h1><p>{this.state.error}</p><button onClick={() => location.reload()}>Try again</button></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <>
    {desktop && <DesktopTitlebar desktop={desktop} />}
    <AppBoundary>
      {demo && <aside className="demo-banner" aria-label="Demo mode">Demo wallet · Sample funds</aside>}
      <div className="wallet-frame"><App /></div>
    </AppBoundary>
  </>,
);
