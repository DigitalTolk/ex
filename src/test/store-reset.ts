import type * as Zustand from 'zustand';

// Every zustand store back to its initial state after each test — zustand's
// own testing recipe (docs: "Testing", resetting state between tests). The
// setup files mock `zustand` with withStoreResets(actual), so each store the
// app creates registers its reset here. Without it a store kept whatever the
// previous test left (a signed-in user's recent searches, a sidebar mode),
// and a test passed or failed depending on which test ran before it.

const resets = new Set<() => void>();

export function withStoreResets(actual: typeof Zustand): typeof Zustand {
  const track = <S extends { getInitialState: () => unknown; setState: (s: never, replace: true) => void }>(store: S): S => {
    const initial = store.getInitialState();
    resets.add(() => store.setState(initial as never, true));
    return store;
  };
  const create = ((creator?: Zustand.StateCreator<unknown>) =>
    // The curried form, create<T>()(creator), is how middleware is typed.
    creator === undefined
      ? (c: Zustand.StateCreator<unknown>) => track(actual.create(c))
      : track(actual.create(creator))) as typeof Zustand.create;
  const createStore = ((creator?: Zustand.StateCreator<unknown>) =>
    creator === undefined
      ? (c: Zustand.StateCreator<unknown>) => track(actual.createStore(c))
      : track(actual.createStore(creator))) as typeof Zustand.createStore;
  return { ...actual, create, createStore };
}

// Runs after the test's own cleanup has unmounted it, so no component is left
// to re-render (and nothing needs act()).
export function resetAllStores(): void {
  for (const reset of resets) reset();
}
