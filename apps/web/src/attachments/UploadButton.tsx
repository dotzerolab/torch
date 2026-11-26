import { useRef, useState } from 'react';
import { cx } from '../design/cx.ts';
import { Button, useT } from '../design/index.ts';

/**
 * Where files come in: a button that opens the file chooser, and a zone that takes files dropped on it or an image pasted
 * into it. It only hands the files over; the caller uploads them. `disabled` turns all three off and `note` says why.
 */
export function UploadButton({
  disabled,
  note,
  onFiles,
}: {
  disabled: boolean;
  note?: string;
  onFiles: (files: File[]) => void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const take = (list: FileList | File[] | null | undefined) => {
    const files = [...(list ?? [])];
    if (!disabled && files.length > 0) onFiles(files);
  };

  return (
    <section
      className={cx('upload', over && 'upload--over', disabled && 'upload--disabled')}
      aria-label={t('attachments.zone')}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the zone takes focus so a pasted image has somewhere to land
      tabIndex={0}
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        take(event.dataTransfer?.files);
      }}
      onPaste={(event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length === 0) return;
        // Only a pasted file is taken; pasted text stays where it was meant to go.
        event.preventDefault();
        take(files);
      }}
    >
      <Button size="sm" disabled={disabled} onClick={() => input.current?.click()}>
        {t('attachments.upload')}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="file-input"
        onChange={(event) => {
          take(event.target.files);
          // The same file can be chosen again.
          event.target.value = '';
        }}
      />
      <span className="upload__hint">{disabled && note ? note : t('attachments.dropHint')}</span>
    </section>
  );
}
