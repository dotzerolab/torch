// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from './MarkdownContent.tsx';

function html(source: string, mentions?: ReadonlySet<string>) {
  const { container } = render(<MarkdownContent source={source} mentions={mentions} />);
  return container;
}

describe('MarkdownContent is inert', () => {
  it('renders a script tag as no element at all', () => {
    const root = html('Hello <script>window.__pwned = 1</script> world');
    expect(root.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('renders raw HTML elements and event handlers as nothing', () => {
    const root = html(
      [
        '<img src=x onerror="window.__pwned = 2">',
        '',
        '<iframe src="https://example.test/frame"></iframe>',
        '',
        '<a href="https://example.test" onclick="window.__pwned = 3">raw link</a>',
        '',
        '<svg onload="window.__pwned = 4"></svg>',
        '',
        '<style>body { display: none }</style>',
      ].join('\n'),
    );
    for (const tag of ['img', 'iframe', 'svg', 'style', 'object', 'embed', 'form']) {
      expect(root.querySelector(tag)).toBeNull();
    }
    expect(root.querySelector('[onerror], [onclick], [onload]')).toBeNull();
    expect(root.querySelector('a')).toBeNull();
  });

  it('refuses a javascript: link and shows its text without an address', () => {
    const root = html('[click me](javascript:alert(1)) and [again](JaVaScRiPt:alert(2))');
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('click me');
    expect(root.innerHTML.toLowerCase()).not.toContain('javascript:');
  });

  it('refuses a data: link, a vbscript: link and a file: link', () => {
    const root = html(
      '[a](data:text/html,<script>alert(1)</script>) [b](vbscript:msgbox) [c](file:///etc/passwd) [d](//example.test/x)',
    );
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('a');
  });

  it('refuses an address hidden with whitespace or encoding', () => {
    const root = html(
      '[a]( javascript:alert(1)) [b](java&#115;cript:alert(1)) [c](&#106;avascript:alert(1))',
    );
    for (const anchor of root.querySelectorAll('a')) {
      expect(anchor.getAttribute('href') ?? '').not.toMatch(/^\s*javascript:/i);
    }
    expect(root.innerHTML.toLowerCase()).not.toMatch(/href="\s*javascript:/);
  });

  it('shows a remote image as its link text and loads nothing', () => {
    const root = html('![the screenshot](https://example.test/a.png)');
    expect(root.querySelector('img')).toBeNull();
    const link = screen.getByRole('link', { name: 'the screenshot' });
    expect(link).toHaveAttribute('href', 'https://example.test/a.png');
  });

  it('shows an image with an unsafe address as its text only', () => {
    const root = html('![tracker](data:image/png;base64,AAAA) ![local](/api/secret)');
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('tracker');
  });

  it('keeps http, https and mailto links, opened safely', () => {
    html('[a](http://example.test/a) [b](https://example.test/b) [c](mailto:someone@example.test)');
    for (const name of ['a', 'b', 'c']) {
      const link = screen.getByRole('link', { name });
      expect(link).toHaveAttribute('target', '_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
    }
    expect(screen.getByRole('link', { name: 'c' })).toHaveAttribute(
      'href',
      'mailto:someone@example.test',
    );
  });

  it('does not make a link of a relative address', () => {
    const root = html('[home](/settings) [anchor](#top)');
    expect(root.querySelector('a')).toBeNull();
  });

  it('links a bare address through GFM, safely', () => {
    html('See https://example.test/page now');
    expect(screen.getByRole('link', { name: 'https://example.test/page' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
  });

  it('renders tables, task lists and strikethrough from GFM, and plain Markdown', () => {
    const root = html(
      [
        '| a | b |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        '- [x] done',
        '- [ ] open',
        '',
        '~~gone~~ **bold** _em_ `code`',
        '',
        '```',
        'let x = 1;',
        '```',
      ].join('\n'),
    );
    expect(root.querySelector('table')).not.toBeNull();
    expect(root.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    // A task box is shown, never a control the reader could change.
    for (const box of root.querySelectorAll('input[type="checkbox"]')) expect(box).toBeDisabled();
    expect(root.querySelector('del')).not.toBeNull();
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('pre code')?.textContent).toContain('let x = 1;');
  });

  it('shows the text of an escaped tag, not its element', () => {
    const root = html('Use `<script>` in code: `<img src=x onerror=1>`');
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<script>');
  });
});

describe('MarkdownContent mentions', () => {
  it('marks @handle when it is a member of the workspace and leaves any other as plain text', () => {
    const root = html('Ping @olivia and @nobody, mail me@example.test', new Set(['olivia']));
    const marks = [...root.querySelectorAll('.md-mention')].map((el) => el.textContent);
    expect(marks).toEqual(['@olivia']);
    expect(root.textContent).toContain('@nobody');
    expect(root.textContent).toContain('me@example.test');
  });

  it('does not mark a mention in code or in a link', () => {
    const root = html('`@olivia` [@olivia](https://example.test)', new Set(['olivia']));
    expect(root.querySelector('.md-mention')).toBeNull();
  });

  it('marks nothing without a member list', () => {
    expect(html('@olivia').querySelector('.md-mention')).toBeNull();
  });
});

it('puts the class on the container', () => {
  const { container } = render(<MarkdownContent source="hi" className="extra" />);
  expect(container.firstElementChild).toHaveClass('md', 'extra');
});
