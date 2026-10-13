import type { ReactNode } from 'react';

import { ChartCalloutPopover } from './callout-popover';
import type { ChartHoverPointerStore } from './linked-hover';

export function AssumedChartHover({ bottom, children, element, pointerStore, top, x }: {
  bottom: number;
  children: ReactNode;
  element: HTMLElement;
  pointerStore: ChartHoverPointerStore;
  top: number;
  x: number;
}) {
  const target = {
    getBoundingClientRect: () => {
      const rect = element.getBoundingClientRect();
      const pointer = pointerStore.getSnapshot();
      return new DOMRect(
        rect.left + (pointer?.xRatio ?? x / rect.width) * rect.width,
        rect.top + (pointer?.yRatio ?? (top + (rect.height - top - bottom) / 2) / rect.height) * rect.height,
        0,
        0,
      );
    },
  };
  return <>
    <div
      aria-hidden="true"
      className="absolute pointer-events-none border-0 border-l border-dashed border-fui-divider"
      data-chart-assumed-hover-cursor=""
      style={{ bottom, left: x, top }}
    />
    <ChartCalloutPopover pointerStore={pointerStore} target={target}>{children}</ChartCalloutPopover>
  </>;
}
