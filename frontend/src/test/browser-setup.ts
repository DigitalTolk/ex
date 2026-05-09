import 'vitest-browser-react';
import '@vitest/browser/matchers';
import '../index.css';
import { APP_VERSION_META, BUILD_VERSION_META } from '@/lib/version-meta';
import './console-gate';

if (typeof document !== 'undefined') {
  if (!document.querySelector(`meta[name="${APP_VERSION_META}"]`)) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', APP_VERSION_META);
    meta.setAttribute('content', 'browser-test');
    document.head.appendChild(meta);
  }
  if (!document.querySelector(`meta[name="${BUILD_VERSION_META}"]`)) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', BUILD_VERSION_META);
    meta.setAttribute('content', 'browser-release-test');
    document.head.appendChild(meta);
  }
}
