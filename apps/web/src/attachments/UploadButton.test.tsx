// @vitest-environment jsdom
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../design/index.ts';
import { UploadButton } from './UploadButton.tsx';

const png = () => new File(['x'], 'shot.png', { type: 'image/png' });

function setup(props: { disabled?: boolean; note?: string } = {}) {
  const onFiles = vi.fn();
  render(
    <LocaleProvider locale="en">
      <UploadButton disabled={props.disabled ?? false} note={props.note} onFiles={onFiles} />
    </LocaleProvider>,
  );
  return {
    onFiles,
    zone: screen.getByRole('region', { name: 'Upload files: choose, drop or paste' }),
  };
}

describe('UploadButton', () => {
  it('hands over the files chosen in the file chooser, and can take the same file again', async () => {
    const { onFiles } = setup();
    const file = png();
    await userEvent.upload(screen.getByTestId('file-input'), file);
    expect(onFiles).toHaveBeenCalledWith([file]);
    await userEvent.upload(screen.getByTestId('file-input'), file);
    expect(onFiles).toHaveBeenCalledTimes(2);
  });

  it('opens the chooser from the button', async () => {
    setup();
    const input = screen.getByTestId('file-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    await userEvent.click(screen.getByRole('button', { name: 'Upload file' }));
    expect(click).toHaveBeenCalled();
  });

  it('takes files dropped on it', () => {
    const { onFiles, zone } = setup();
    const file = png();
    fireEvent.dragOver(zone, { dataTransfer: { files: [file] } });
    expect(zone).toHaveClass('upload--over');
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(zone).not.toHaveClass('upload--over');
  });

  it('takes an image pasted into it, and leaves pasted text alone', () => {
    const { onFiles, zone } = setup();
    const file = png();
    const paste = createEvent.paste(zone, { clipboardData: { files: [file] } });
    fireEvent(zone, paste);
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(paste.defaultPrevented).toBe(true);

    onFiles.mockClear();
    const text = createEvent.paste(zone, { clipboardData: { files: [], getData: () => 'text' } });
    fireEvent(zone, text);
    expect(onFiles).not.toHaveBeenCalled();
    expect(text.defaultPrevented).toBe(false);
  });

  it('when disabled the button is off, a drop or a paste hands over nothing, and the note says why', () => {
    const { onFiles, zone } = setup({ disabled: true, note: 'Uploads need a connection.' });
    expect(screen.getByRole('button', { name: 'Upload file' })).toBeDisabled();
    expect(screen.getByText('Uploads need a connection.')).toBeInTheDocument();
    fireEvent.drop(zone, { dataTransfer: { files: [png()] } });
    fireEvent(zone, createEvent.paste(zone, { clipboardData: { files: [png()] } }));
    expect(onFiles).not.toHaveBeenCalled();
  });
});
