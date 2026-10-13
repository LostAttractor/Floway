import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';

export interface ChartHoverBucket {
  start: number;
  end: number;
}
export interface ChartHoverPointer { xRatio: number; yRatio: number }

export interface ChartHoverPointerStore {
  getSnapshot: () => ChartHoverPointer | null;
  subscribe: (listener: () => void) => () => void;
}

interface LinkedHoverState {
  sourceId: string;
  interval: ChartHoverBucket;
}

interface LinkedChartHoverStore extends ChartHoverPointerStore {
  getHover: () => LinkedHoverState | null;
  report: (sourceId: string, interval: ChartHoverBucket | null, pointer: ChartHoverPointer | null) => void;
  subscribeHover: (listener: () => void) => () => void;
}

export interface AssumedChartHoverStore<T extends ChartHoverBucket> {
  getSnapshot: () => T | null;
  subscribe: (listener: () => void) => () => void;
}

const LinkedHoverContext = createContext<LinkedChartHoverStore | null>(null);

const createLinkedHoverStore = (): LinkedChartHoverStore => {
  let pointer: ChartHoverPointer | null = null;
  let hover: LinkedHoverState | null = null;
  const pointerListeners = new Set<() => void>();
  const hoverListeners = new Set<() => void>();
  const publishPointer = (next: ChartHoverPointer | null) => {
    if (pointer?.xRatio === next?.xRatio && pointer?.yRatio === next?.yRatio) return;
    pointer = next;
    for (const listener of pointerListeners) listener();
  };
  return {
    getHover: () => hover,
    getSnapshot: () => pointer,
    report: (sourceId, interval, nextPointer) => {
      if (interval !== null) {
        publishPointer(nextPointer);
        if (hover?.sourceId === sourceId && hover.interval.start === interval.start && hover.interval.end === interval.end) return;
        hover = { sourceId, interval };
      } else {
        if (hover?.sourceId !== sourceId) return;
        hover = null;
        publishPointer(null);
      }
      for (const listener of hoverListeners) listener();
    },
    subscribe: listener => {
      pointerListeners.add(listener);
      return () => pointerListeners.delete(listener);
    },
    subscribeHover: listener => {
      hoverListeners.add(listener);
      return () => hoverListeners.delete(listener);
    },
  };
};

export const chartHoverPointer = (element: HTMLElement, clientX: number, clientY: number): ChartHoverPointer => {
  const rect = element.getBoundingClientRect();
  return {
    xRatio: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    yRatio: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
  };
};

// A coarse target follows the source interval's right edge: 09:59-10:01
// therefore selects 10:00-11:00 rather than the preceding hour.
export const assumedChartHoverBucket = <T extends ChartHoverBucket>(
  buckets: readonly T[],
  interval: ChartHoverBucket | null,
): T | null => interval === null ? null : buckets.find(bucket => bucket.end >= interval.end) ?? null;

export function LinkedChartHoverProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createLinkedHoverStore);
  return <LinkedHoverContext value={store}>{children}</LinkedHoverContext>;
}

export const useLinkedChartHover = <T extends ChartHoverBucket>(buckets: readonly T[]) => {
  const id = useId();
  const context = useContext(LinkedHoverContext);
  const [localStore] = useState(createLinkedHoverStore);
  const store = context ?? localStore;
  const report = useCallback((bucket: T | null, pointer: ChartHoverPointer | null = null) => {
    store.report(id, bucket, pointer);
  }, [id, store]);
  useEffect(() => () => store.report(id, null, null), [id, store]);
  const assumedStore = useMemo<AssumedChartHoverStore<T>>(() => ({
    getSnapshot: () => {
      const hover = store.getHover();
      return hover?.sourceId === id ? null : assumedChartHoverBucket(buckets, hover?.interval ?? null);
    },
    subscribe: store.subscribeHover,
  }), [buckets, id, store]);
  return { assumedStore, pointerStore: store, report };
};

export function LinkedChartAssumedHover<T extends ChartHoverBucket>({ children, store }: { children: (bucket: T | null) => ReactNode; store: AssumedChartHoverStore<T> }) {
  const bucket = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return children(bucket);
}
