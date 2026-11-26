import { X } from 'lucide-react';
import { useT } from '../design/locale.tsx';

/**
 * A filter value that names something that is no longer there (an archived label or state, a person who was deactivated,
 * an id this workspace never had). It still filters, so the list is not silently widened, and it can be removed.
 */
export function StaleChip({
  kind,
  onRemove,
}: {
  kind: 'state' | 'label' | 'person';
  onRemove: () => void;
}) {
  const t = useT();
  const text = t(`filter.stale.${kind}`);
  return (
    <span className="chip chip--stale" data-stale="true">
      <span className="chip__text">{text}</span>
      <button
        type="button"
        className="chip__remove"
        aria-label={t('filter.remove', { name: text })}
        onClick={onRemove}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </span>
  );
}
