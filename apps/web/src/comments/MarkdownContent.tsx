// The one renderer of Markdown that other people wrote (comments, documents, and later descriptions). It renders what
// Markdown means and nothing else: no raw HTML (it is dropped, not escaped into view), links only to http, https and mailto
// opened with `noopener noreferrer` and no referrer, an image shown as the link text of its alt (nothing is fetched on
// reading, so no remote image can report who read it), task boxes that cannot be ticked. There is no
// `dangerouslySetInnerHTML` anywhere.
import { type ComponentProps, type ReactNode, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cx } from '../design/cx.ts';
import './comments.css';

type Plugins = NonNullable<ComponentProps<typeof Markdown>['remarkPlugins']>;
type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> };

const SAFE_LINK = /^(?:https?:|mailto:)/i;
const SAFE_WEB = /^https?:/i;

/** The only addresses a link or an image may carry; anything else (relative, `javascript:`, `data:`) is dropped. */
export function safeUrl(url: string | null | undefined): string | null {
  const trimmed = (url ?? '').trim();
  return SAFE_LINK.test(trimmed) ? trimmed : null;
}

const MENTION = /(^|[^\w@./-])@([A-Za-z0-9][A-Za-z0-9._-]*)/g;
const NOT_MENTIONED = new Set([
  'link',
  'linkReference',
  'image',
  'imageReference',
  'code',
  'inlineCode',
  'html',
]);

/** Splits a text into plain parts and `@handle` spans for the handles that belong to a member. */
function splitMentions(text: string, handles: ReadonlySet<string>): Node[] | null {
  const parts: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const lead = match[1] ?? '';
    const raw = match[2] ?? '';
    const handle = raw.replace(/[._-]+$/, '');
    if (!handles.has(handle.toLowerCase())) continue;
    const start = (match.index ?? 0) + lead.length;
    const end = start + 1 + handle.length;
    if (start > last) parts.push({ type: 'text', value: text.slice(last, start) });
    parts.push({
      type: 'strong',
      data: { hName: 'span', hProperties: { className: ['md-mention'] } },
      children: [{ type: 'text', value: text.slice(start, end) }],
    });
    last = end;
  }
  if (parts.length === 0) return null;
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

function remarkMentions(handles: ReadonlySet<string>): Plugins[number] {
  const walk = (node: Node) => {
    if (!node.children || NOT_MENTIONED.has(node.type)) return;
    const next: Node[] = [];
    for (const child of node.children) {
      const parts = child.type === 'text' ? splitMentions(child.value ?? '', handles) : null;
      if (parts) next.push(...parts);
      else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return () => (tree: Node) => walk(tree);
}

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const safe = safeUrl(href);
  if (!safe) return <span>{children}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
      {children}
    </a>
  );
}

/** An image is never loaded: it reads as a link to it when its address is a web one, else as its alt text. */
function Picture({ src, alt }: { src?: string | Blob; alt?: string }) {
  const address = typeof src === 'string' ? src.trim() : '';
  const label = alt || address;
  if (!SAFE_WEB.test(address)) return <span>{alt}</span>;
  return <Link href={address}>{label}</Link>;
}

const COMPONENTS = { a: Link, img: Picture };

export function MarkdownContent({
  source,
  className,
  mentions,
}: {
  source: string;
  className?: string;
  /** Lower-case handles of the members of the workspace: an `@handle` that matches one is highlighted. */
  mentions?: ReadonlySet<string>;
}) {
  const plugins = useMemo<Plugins>(
    () => (mentions && mentions.size > 0 ? [remarkGfm, remarkMentions(mentions)] : [remarkGfm]),
    [mentions],
  );
  return (
    <div className={cx('md', className)}>
      <Markdown
        remarkPlugins={plugins}
        skipHtml
        urlTransform={(url) => safeUrl(url)}
        components={COMPONENTS}
      >
        {source}
      </Markdown>
    </div>
  );
}
