import { Page } from 'playwright';

/**
 * browser_extract — pull page content the token-efficient way (cribbed from
 * Scrapling's MCP `get`/`fetch` content handling):
 *   - `selector` narrows to just the matching subtree(s) before extraction —
 *     kills "8000 chars of nav/footer/cookie-banner to find one paragraph"
 *   - `format`: text (innerText, smallest), html (when structure matters),
 *     markdown (headings/lists/links/code render clean — fewest tokens per unit
 *     of readable content; tables pass through as HTML)
 *   - `mainContentOnly` — fall back to <main>/<article>/<body> if no selector
 *   - prompt-injection sanitization — strip CSS-hidden / aria-hidden /
 *     <template> / <script>/<style>/<noscript> / comments / zero-width unicode
 *     before extracting (cheap, good hygiene even on trusted authed apps)
 *
 * Markdown conversion is a small built-in (no `turndown` dep — the box's npm
 * registry is flaky and the core value is the narrowing, not perfect markdown).
 */

export interface ExtractOpts {
  selector?: string | undefined;
  format?: 'text' | 'html' | 'markdown' | undefined;
  mainContentOnly?: boolean | undefined;
  sanitize?: boolean | undefined;          // default true
  limit?: number | undefined;              // truncate output to N chars
}

export interface ExtractResult {
  url: string;
  title: string;
  format: 'text' | 'html' | 'markdown';
  matched: number;                          // # of elements the selector matched (1 when no selector)
  content: string;
  truncated: boolean;
}

export async function extractContent(page: Page, opts: ExtractOpts = {}): Promise<ExtractResult> {
  const format = opts.format ?? 'text';
  const sanitize = opts.sanitize !== false;
  const limit = Math.min(opts.limit ?? 16000, 200000);

  const raw = await page.evaluate(({ selector, mainContentOnly, sanitize, wantMarkdown }) => {
    const ZW = /[​-‍⁠﻿]/g;

    const stripHidden = (root: Element): void => {
      const kill: Element[] = [];
      root.querySelectorAll<HTMLElement>('*').forEach(el => {
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') { kill.push(el); return; }
        if (el.getAttribute('aria-hidden') === 'true') { kill.push(el); return; }
        try {
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) { kill.push(el); return; }
          const fs = parseFloat(s.fontSize); if (!isNaN(fs) && fs === 0) { kill.push(el); return; }
        } catch {}
      });
      kill.forEach(el => el.remove());
      const w = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
      const comments: Node[] = []; let n; while ((n = w.nextNode())) comments.push(n);
      comments.forEach(c => c.parentNode?.removeChild(c));
    };

    // --- minimal HTML → Markdown ---
    const md = (root: Element): string => {
      const esc = (t: string) => t.replace(/([\\`*_{}\[\]()#+\-.!|])/g, '\\$1');
      const out: string[] = [];
      const walk = (node: Node, listCtx: { type: 'ul' | 'ol' | null; idx: number; depth: number }): string => {
        if (node.nodeType === 3) return (node.textContent || '').replace(/\s+/g, ' ');
        if (node.nodeType !== 1) return '';
        const el = node as Element; const tag = el.tagName.toLowerCase();
        const kids = () => Array.from(el.childNodes).map(c => walk(c, listCtx)).join('');
        const block = (s: string) => '\n\n' + s.trim() + '\n\n';
        switch (tag) {
          case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
            return block('#'.repeat(+tag[1]!) + ' ' + kids().trim());
          case 'p': case 'div': case 'section': case 'article': case 'header': case 'footer': case 'main':
            return block(kids());
          case 'br': return '  \n';
          case 'hr': return '\n\n---\n\n';
          case 'strong': case 'b': return '**' + kids().trim() + '**';
          case 'em': case 'i': return '*' + kids().trim() + '*';
          case 'code': return el.closest('pre') ? kids() : '`' + (el.textContent || '') + '`';
          case 'pre': return block('```\n' + (el.textContent || '').replace(/\n+$/, '') + '\n```');
          case 'blockquote': return block(kids().trim().split('\n').map(l => '> ' + l).join('\n'));
          case 'a': { const h = el.getAttribute('href') || ''; const txt = kids().trim() || h; return h && !h.startsWith('javascript:') ? `[${txt}](${h})` : txt; }
          case 'img': { const a = el.getAttribute('alt') || ''; const s = el.getAttribute('src') || ''; return s ? `![${a}](${s})` : ''; }
          case 'ul': case 'ol': {
            const items = Array.from(el.children).filter(c => c.tagName === 'LI');
            const lines = items.map((li, i) => {
              const inner = Array.from(li.childNodes).map(c => walk(c, { type: tag as 'ul' | 'ol', idx: i, depth: listCtx.depth + 1 })).join('').trim().replace(/\n/g, '\n  ');
              const bullet = tag === 'ol' ? `${i + 1}.` : '-';
              return '  '.repeat(listCtx.depth) + bullet + ' ' + inner;
            });
            return '\n\n' + lines.join('\n') + '\n\n';
          }
          case 'li': return kids();
          case 'table': return '\n\n' + (el as HTMLElement).outerHTML + '\n\n';   // pass tables through as HTML
          default: return kids();
        }
      };
      out.push(walk(root, { type: null, idx: 0, depth: 0 }));
      return out.join('').replace(/\n{3,}/g, '\n\n').trim();
    };

    let roots: Element[];
    if (selector) {
      roots = Array.from(document.querySelectorAll(selector as string));
      if (roots.length === 0) throw new Error(`selector matched nothing: ${selector}`);
    } else if (mainContentOnly) {
      const main = document.querySelector('main') || document.querySelector('article') || document.querySelector('[role="main"]') || document.body;
      roots = [main];
    } else {
      roots = [document.body || document.documentElement];
    }

    const htmls: string[] = []; const texts: string[] = []; const mds: string[] = [];
    for (const r of roots) {
      const clone = r.cloneNode(true) as Element;
      if (sanitize) stripHidden(clone);
      const holder = document.createElement('div'); holder.appendChild(clone);
      let txt = (holder.innerText || holder.textContent || '');
      if (sanitize) txt = txt.replace(ZW, '');
      htmls.push((clone as HTMLElement).outerHTML);
      texts.push(txt);
      if (wantMarkdown) { try { mds.push(md(clone)); } catch { mds.push(txt); } }
    }
    return { url: location.href, title: document.title, matched: roots.length, html: htmls.join('\n\n'), text: texts.join('\n\n'), markdown: wantMarkdown ? mds.join('\n\n---\n\n') : '' };
  }, { selector: opts.selector ?? null, mainContentOnly: opts.mainContentOnly !== false && !opts.selector, sanitize, wantMarkdown: format === 'markdown' });

  let content: string;
  if (format === 'html') content = raw.html;
  else if (format === 'markdown') content = raw.markdown || raw.text;
  else content = raw.text;

  const truncated = content.length > limit;
  if (truncated) content = content.slice(0, limit);
  return { url: raw.url, title: raw.title, format, matched: raw.matched, content, truncated };
}
