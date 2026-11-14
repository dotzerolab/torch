// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from './Badge.tsx';
import { EmptyState } from './EmptyState.tsx';
import { Input } from './Input.tsx';
import { Skeleton } from './Skeleton.tsx';
import { Spinner } from './Spinner.tsx';
import { Textarea } from './Textarea.tsx';

describe('small pieces', () => {
  it('EmptyState shows its title, description and action', () => {
    render(
      <EmptyState
        title="No issues"
        description="Create the first one."
        action={<button type="button">New issue</button>}
      />,
    );
    expect(screen.getByText('No issues')).toBeInTheDocument();
    expect(screen.getByText('Create the first one.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New issue' })).toBeInTheDocument();
  });

  it('Input and Textarea forward their ref and mark themselves invalid', () => {
    const inputRef = { current: null as HTMLInputElement | null };
    const textareaRef = { current: null as HTMLTextAreaElement | null };
    render(
      <>
        <Input ref={inputRef} aria-label="Name" invalid />
        <Textarea ref={textareaRef} aria-label="Notes" />
      </>,
    );
    expect(inputRef.current).toBe(screen.getByLabelText('Name'));
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(textareaRef.current).toBe(screen.getByLabelText('Notes'));
    expect(screen.getByLabelText('Notes')).not.toHaveAttribute('aria-invalid');
  });

  it('Badge takes a tone class', () => {
    render(<Badge tone="danger">Blocked</Badge>);
    expect(screen.getByText('Blocked')).toHaveClass('badge', 'badge--danger');
  });

  it('Spinner announces loading in the current language', () => {
    render(<Spinner />);
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
  });

  it('Skeleton is hidden from assistive technology and takes a size', () => {
    const { container } = render(<Skeleton width="120px" height="12px" />);
    const element = container.firstElementChild as HTMLElement;
    expect(element).toHaveAttribute('aria-hidden', 'true');
    expect(element.style.width).toBe('120px');
    expect(element.style.height).toBe('12px');
  });
});
