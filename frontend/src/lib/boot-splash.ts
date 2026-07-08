// The inline boot splash in index.html covers the window between "HTML
// committed" and "React committed" — the stretch where a stalled JS-bundle
// fetch used to leave a permanently blank page on mobile webviews. Once React
// renders its first frame the in-app loading states (AuthLoadingScreen) take
// over, so the splash must go.
export function removeBootSplash(): void {
  document.getElementById('boot-splash')?.remove();
}
