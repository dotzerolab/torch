import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactElement } from 'react';

/** A short label on hover and keyboard focus. The child must be one element that takes a ref and props. */
export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: string;
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content className="tooltip" side={side} sideOffset={6}>
            {content}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
