import { Page } from 'playwright';
import { Logger } from '@utils/logger';

/**
 * find_similar — given one anchor element, return DOM elements that are
 * STRUCTURALLY similar (same tag, overlapping class/attr names, similar
 * depth + sibling/child shape). Adapted from Scrapling's parser feature.
 * Useful for "give me all the product cards / user rows / nav links /
 * API-ref scripts on this page" without writing N selectors.
 */
export async function findSimilar(
  page: Page,
  anchorSelector: string,
  opts: { minScore?: number; limit?: number } = {},
): Promise<{ anchor: any; matches: any[] }> {
  const minScore = opts.minScore ?? 0.55;
  const limit = Math.min(opts.limit ?? 50, 500);
  return page.evaluate(({ sel, minScore, limit }) => {
    const anchor = document.querySelector(sel as string) as HTMLElement | null;
    if (!anchor) throw new Error(`anchor selector matched nothing: ${sel}`);

    const domDepth = (el: Element) => { let d = 0; let p: Element | null = el; while (p) { d++; p = p.parentElement; } return d; };
    const sig = (el: Element) => ({
      tag: el.tagName.toLowerCase(),
      classes: new Set(Array.from(el.classList)),
      attrs: new Set(Array.from(el.attributes).map(a => a.name).filter(n => n !== 'class' && n !== 'style')),
      parentTag: (el.parentElement?.tagName || '').toLowerCase(),
      parentClasses: new Set(Array.from(el.parentElement?.classList || [])),
      grandTag: (el.parentElement?.parentElement?.tagName || '').toLowerCase(),
      grandClasses: new Set(Array.from(el.parentElement?.parentElement?.classList || [])),
      childCount: el.childElementCount,
      depth: domDepth(el),
      hasText: !!(el.textContent || '').trim(),
      hasHref: el.hasAttribute('href'),
    });
    const jaccard = (a: Set<string>, b: Set<string>) => {
      if (a.size === 0 && b.size === 0) return 1;
      let inter = 0; a.forEach(x => { if (b.has(x)) inter++; });
      const uni = a.size + b.size - inter;
      return uni === 0 ? 0 : inter / uni;
    };
    const aSig = sig(anchor);

    // CSS-path-ish selector for a node (best-effort, for reporting).
    const pathOf = (el: Element): string => {
      const parts: string[] = [];
      let cur: Element | null = el;
      let depth = 0;
      while (cur && cur.nodeType === 1 && depth < 6) {
        let part = cur.tagName.toLowerCase();
        if ((cur as HTMLElement).id) { part += `#${(cur as HTMLElement).id}`; parts.unshift(part); break; }
        const cls = Array.from(cur.classList).slice(0, 2).map((c: string) => `.${CSS.escape(c)}`).join('');
        if (cls) part += cls;
        const parentEl: Element | null = cur.parentElement;
        if (parentEl) {
          const sameTag = Array.from(parentEl.children).filter((c: Element) => c.tagName === cur!.tagName);
          if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
        }
        parts.unshift(part);
        cur = parentEl;
        depth++;
      }
      return parts.join(' > ');
    };

    const scored: Array<{ el: Element; score: number }> = [];
    const all = document.querySelectorAll(aSig.tag);
    all.forEach(el => {
      if (el === anchor) return;
      const s = sig(el);
      let score = 0;
      // tag already matches (we queried by tag) → base 0.18
      score += 0.18;
      score += jaccard(aSig.classes, s.classes) * 0.22;
      score += jaccard(aSig.attrs, s.attrs) * 0.10;
      // Ancestry — the strong signal when the anchor itself is classless
      // (e.g. <a> inside <span class="titleline">): compare the parent's and
      // grandparent's tag AND class set, so siblings of the same component
      // rank far above unrelated same-tag elements elsewhere on the page.
      if (s.parentTag === aSig.parentTag) score += 0.08;
      score += jaccard(aSig.parentClasses, s.parentClasses) * 0.14;
      if (s.grandTag === aSig.grandTag) score += 0.05;
      score += jaccard(aSig.grandClasses, s.grandClasses) * 0.09;
      if (Math.abs(s.depth - aSig.depth) <= 1) score += 0.06;
      if (Math.abs(s.childCount - aSig.childCount) <= 1) score += 0.04;
      if (s.hasText === aSig.hasText) score += 0.02;
      if (s.hasHref === aSig.hasHref) score += 0.02;
      if (score >= (minScore as number)) scored.push({ el, score });
    });
    scored.sort((a, b) => b.score - a.score);

    const describe = (el: Element) => ({
      selector: pathOf(el),
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 120),
      href: el.getAttribute('href') || undefined,
      classes: Array.from(el.classList),
      visible: !!((el as HTMLElement).offsetParent),
    });

    return {
      anchor: describe(anchor),
      matches: scored.slice(0, limit as number).map(({ el, score }) => ({ ...describe(el), score: Math.round(score * 1000) / 1000 })),
    };
  }, { sel: anchorSelector, minScore, limit });
}

/**
 * crawl — in-browser BFS crawl from a start URL. Renders JS so it catches
 * client-rendered links / lazy routes / JS-injected forms that a passive
 * crawler (BBOT) misses. Returns per-page {links, forms, scripts} plus a
 * de-duped aggregate. Hard caps on pages/depth to avoid runaways.
 */
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf|eot|map|pdf|zip|gz|tar|mp4|webm|mp3|wav|avi|mov|dmg|exe|woff|otf)(\?|#|$)/i;

export async function crawl(
  page: Page,
  startUrl: string,
  opts: { maxPages?: number; maxDepth?: number; sameDomain?: boolean; perPageTimeoutMs?: number } = {},
): Promise<{
  start: string;
  pagesCrawled: number;
  pages: Array<{ url: string; depth: number; status?: number; title: string; links: string[]; forms: any[]; scripts: string[] }>;
  aggregate: { urls: string[]; forms: any[]; scripts: string[] };
}> {
  const maxPages = Math.min(opts.maxPages ?? 40, 200);
  const maxDepth = Math.min(opts.maxDepth ?? 2, 5);
  const sameDomain = opts.sameDomain !== false;
  const perPageTimeout = opts.perPageTimeoutMs ?? 20000;

  const startHost = (() => { try { return new URL(startUrl).hostname; } catch { throw new Error(`invalid startUrl: ${startUrl}`); } })();
  const sameSite = (u: string) => { try { const h = new URL(u).hostname; return h === startHost || h.endsWith('.' + startHost.split('.').slice(-2).join('.')); } catch { return false; } };

  const seen = new Set<string>([startUrl.split('#')[0]!]);
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  const pages: any[] = [];
  const allUrls = new Set<string>();
  const allForms: any[] = [];
  const allScripts = new Set<string>();

  while (queue.length && pages.length < maxPages) {
    const { url, depth } = queue.shift()!;
    let status: number | undefined;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: perPageTimeout });
      status = resp?.status();
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
    } catch (e) {
      Logger.debug('crawl: nav failed', { url, error: (e as Error).message });
      pages.push({ url, depth, title: '', links: [], forms: [], scripts: [], status });
      continue;
    }

    const harvested = await page.evaluate(() => {
      const abs = (h: string) => { try { return new URL(h, location.href).href.split('#')[0] || null; } catch { return null; } };
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map(a => abs((a as HTMLAnchorElement).getAttribute('href') || ''))
        .filter((u): u is string => !!u && /^https?:/.test(u));
      const forms = Array.from(document.querySelectorAll('form')).map(f => ({
        action: abs((f as HTMLFormElement).getAttribute('action') || '') || location.href,
        method: ((f as HTMLFormElement).getAttribute('method') || 'get').toLowerCase(),
        inputs: Array.from(f.querySelectorAll('input,select,textarea')).map((el: any) => ({ name: el.name || '', type: el.type || '' })).filter(i => i.name),
      }));
      const scripts = Array.from(document.querySelectorAll('script[src]'))
        .map(s => abs((s as HTMLScriptElement).getAttribute('src') || ''))
        .filter((u): u is string => !!u && /^https?:/.test(u));
      return { title: document.title, links: Array.from(new Set(links)), forms, scripts: Array.from(new Set(scripts)) };
    });

    pages.push({ url, depth, status, title: harvested.title, links: harvested.links, forms: harvested.forms, scripts: harvested.scripts });
    harvested.links.forEach(u => allUrls.add(u));
    harvested.scripts.forEach(u => allScripts.add(u));
    harvested.forms.forEach((f: any) => allForms.push({ ...f, foundOn: url }));

    if (depth < maxDepth) {
      for (const link of harvested.links) {
        const norm = link.split('#')[0]!;
        if (seen.has(norm)) continue;
        if (SKIP_EXT.test(norm)) continue;
        if (sameDomain && !sameSite(norm)) continue;
        seen.add(norm);
        queue.push({ url: norm, depth: depth + 1 });
      }
    }
  }

  return {
    start: startUrl,
    pagesCrawled: pages.length,
    pages,
    aggregate: { urls: Array.from(allUrls).sort(), forms: allForms, scripts: Array.from(allScripts).sort() },
  };
}
