// Vite injects this at build time (see vite.config.ts) and vitest mirrors
// it to "test" (see vitest.config.ts) so version-aware modules get a
// deterministic compile-time constant.
declare const __BUILD_VERSION__: string;
