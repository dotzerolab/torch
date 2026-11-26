// The small marks a row, a card and a picker share: the dot of a workflow state and the bars of a priority.

/** A coloured dot for a workflow state; the colour comes from the state's own row. */
export function StateDot({ color }: { color: string }) {
  return <span className="state-dot" style={{ background: color }} aria-hidden="true" />;
}

/** Urgent (1) is a filled warning square, high to low (2-4) are three bars of which 3, 2 and 1 are lit, none (0) is a dash. */
export function PriorityIcon({ priority }: { priority: number }) {
  if (priority === 1) {
    return (
      <svg
        className="priority-icon priority-icon--urgent"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        aria-hidden="true"
      >
        <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
        <rect x="6.2" y="3.5" width="1.6" height="4.5" rx="0.8" fill="var(--bg-elevated)" />
        <rect x="6.2" y="9" width="1.6" height="1.6" rx="0.8" fill="var(--bg-elevated)" />
      </svg>
    );
  }
  if (priority < 1 || priority > 4) {
    return (
      <svg className="priority-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <rect x="2" y="6.2" width="10" height="1.6" rx="0.8" fill="currentColor" opacity="0.5" />
      </svg>
    );
  }
  const lit = 5 - priority;
  return (
    <svg className="priority-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {[0, 1, 2].map((bar) => (
        <rect
          key={bar}
          x={2 + bar * 4}
          y={9 - bar * 3}
          width="2.4"
          height={3 + bar * 3}
          rx="0.8"
          fill="currentColor"
          opacity={bar < lit ? 1 : 0.25}
        />
      ))}
    </svg>
  );
}
