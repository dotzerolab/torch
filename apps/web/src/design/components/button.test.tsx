// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button.tsx';
import { IconButton } from './IconButton.tsx';

describe('Button', () => {
  it('renders a button with the class of its variant', () => {
    render(<Button variant="primary">Create</Button>);
    const button = screen.getByRole('button', { name: 'Create' });
    expect(button).toHaveClass('btn', 'btn--primary');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('calls onClick when pressed', async () => {
    const onClick = vi.fn();
    render(
      <Button variant="secondary" onClick={onClick}>
        Go
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('marks itself busy and ignores clicks while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: /Save/ });
    expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('ignores clicks while disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button variant="danger" disabled onClick={onClick}>
        Delete
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('IconButton', () => {
  it('is found by its label', () => {
    render(<IconButton label="Close" icon={<svg aria-hidden="true" />} />);
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('shows its label as a tooltip on keyboard focus', async () => {
    render(<IconButton label="Close" icon={<svg aria-hidden="true" />} />);
    await userEvent.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Close');
  });

  it('shows no tooltip when switched off', async () => {
    render(<IconButton label="Close" tooltip={false} icon={<svg aria-hidden="true" />} />);
    await userEvent.tab();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('requires a label (compile-time check)', () => {
    // @ts-expect-error label is required
    const element = <IconButton icon={<span />} />;
    expect(element).toBeTruthy();
  });
});
