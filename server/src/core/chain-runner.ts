import { Page } from 'playwright';
import { Logger } from '@utils/logger';

/**
 * browser_chain — execute a sequence of browser ops server-side in one shot,
 * returning only the final state. Collapses what would be N MCP round-trips
 * (each = HTTP + the caller's reasoning between calls) into 1. This is the
 * "page_action function" pattern from Scrapling, adapted to MCP.
 *
 * A chain is an array of single-key step objects, e.g.:
 *   [ {navigate:{url}}, {waitFor:{selector:"#u"}}, {type:{selector:"#u",text:"x"}},
 *     {type:{selector:"#p",text:"y"}}, {click:{selector:"button[type=submit]"}},
 *     {waitFor:{text:"Dashboard"}}, {returnState:{text:true,forms:true,url:true}} ]
 *
 * Steps run in order. By default a failing step aborts the chain (records the
 * error and stops); pass `continueOnError:true` to push through. Always ends by
 * collecting a state snapshot (whatever `returnState` requested, or a default).
 */

export interface ChainStep {
  navigate?: { url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout?: number; referer?: string };
  waitFor?: { selector?: string; text?: string; timeout?: number };
  type?: { selector: string; text: string; clear?: boolean; delay?: number };
  keyboardType?: { selector?: string; text: string; delay?: number };
  click?: { selector: string };
  clickText?: { text: string };
  press?: { key: string };           // page.keyboard.press, e.g. "Enter", "Tab"
  eval?: { script: string; arg?: unknown };
  scroll?: { to?: 'top' | 'bottom'; selector?: string };
  sleep?: { ms: number };
  screenshot?: { path?: string; fullPage?: boolean };
  returnState?: { url?: boolean; title?: boolean; text?: boolean; textLimit?: number; forms?: boolean; html?: boolean; htmlLimit?: number };
}

export interface ChainStepResult {
  step: string;            // op name
  ok: boolean;
  detail?: unknown;        // small result, e.g. eval return value, click target
  error?: string;
  ms: number;
}

export interface ChainResult {
  steps: ChainStepResult[];
  aborted: boolean;
  state: {
    url?: string;
    title?: string;
    text?: string;
    forms?: unknown;
    html?: string;
    screenshotPath?: string;
  };
  durationMs: number;
}

async function snapshotState(page: Page, req: NonNullable<ChainStep['returnState']>): Promise<ChainResult['state']> {
  const state: ChainResult['state'] = {};
  if (req.url !== false) state.url = page.url();
  if (req.title !== false) state.title = await page.title().catch(() => '');
  if (req.text) {
    const limit = Math.min(req.textLimit ?? 8000, 30000);
    state.text = await page.evaluate((lim) => (document.body?.innerText || '').slice(0, lim as number), limit).catch(() => '');
  }
  if (req.forms) {
    state.forms = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input,select,textarea')).map((el: any) => ({
        tag: el.tagName.toLowerCase(), name: el.name || '', id: el.id || '', type: el.type || '',
        placeholder: el.placeholder || '', valLen: (el.value || '').length, visible: !!(el.offsetParent), disabled: !!el.disabled,
      }));
      const buttons = Array.from(document.querySelectorAll('button,input[type=submit],input[type=button],[role=button]')).map((el: any) => ({
        text: (el.textContent || el.value || '').trim().slice(0, 60), type: el.type || '', disabled: !!el.disabled, visible: !!(el.offsetParent),
      }));
      return { url: location.href, inputs, buttons };
    }).catch(() => null);
  }
  if (req.html) {
    const limit = Math.min(req.htmlLimit ?? 50000, 500000);
    state.html = (await page.content().catch(() => '')).slice(0, limit);
  }
  return state;
}

export async function runChain(page: Page, steps: ChainStep[], opts: { continueOnError?: boolean; defaultTimeout?: number } = {}): Promise<ChainResult> {
  const start = Date.now();
  const results: ChainStepResult[] = [];
  let aborted = false;
  let lastReturnState: ChainStep['returnState'] = { url: true, title: true };
  const dt = opts.defaultTimeout ?? 30000;

  for (const raw of steps) {
    const op = Object.keys(raw)[0] as keyof ChainStep | undefined;
    if (!op) { results.push({ step: '(empty)', ok: false, error: 'empty step', ms: 0 }); if (!opts.continueOnError) { aborted = true; break; } continue; }
    const t0 = Date.now();
    try {
      let detail: unknown;
      switch (op) {
        case 'navigate': {
          const a = raw.navigate!;
          await page.goto(a.url, { waitUntil: a.waitUntil ?? 'domcontentloaded', timeout: a.timeout ?? dt, ...(a.referer ? { referer: a.referer } : {}) });
          detail = { url: page.url() };
          break;
        }
        case 'waitFor': {
          const a = raw.waitFor!;
          if (a.selector) await page.waitForSelector(a.selector, { timeout: a.timeout ?? 10000 });
          else if (a.text) await page.waitForFunction((txt) => document.body?.innerText?.includes(txt as string), a.text, { timeout: a.timeout ?? 10000 });
          else throw new Error('waitFor needs selector or text');
          break;
        }
        case 'type': {
          const a = raw.type!;
          if (a.clear) await page.fill(a.selector, '');
          await page.type(a.selector, a.text, a.delay ? { delay: a.delay } : undefined);
          detail = { selector: a.selector, len: a.text.length };
          break;
        }
        case 'keyboardType': {
          const a = raw.keyboardType!;
          if (a.selector) await page.focus(a.selector);
          await page.keyboard.type(a.text, a.delay ? { delay: a.delay } : undefined);
          detail = { len: a.text.length };
          break;
        }
        case 'click': { await page.click(raw.click!.selector); detail = { selector: raw.click!.selector }; break; }
        case 'clickText': {
          const txt = raw.clickText!.text;
          await page.locator(`text=${JSON.stringify(txt)}`).first().click({ timeout: 10000 });
          detail = { text: txt };
          break;
        }
        case 'press': { await page.keyboard.press(raw.press!.key); detail = { key: raw.press!.key }; break; }
        case 'eval': {
          const a = raw.eval!;
          const fn = new Function('__arg', `return (async () => { ${/return|;|=>/.test(a.script) ? a.script : 'return (' + a.script + ')'} })()`);
          // We pass it through page.evaluate as a string body for proper serialization.
          const wrapped = `(async () => { const __arg = ${JSON.stringify(a.arg ?? null)}; ${/\breturn\b/.test(a.script) ? a.script : 'return (' + a.script + ');'} })()`;
          detail = await page.evaluate(wrapped);
          void fn;
          break;
        }
        case 'scroll': {
          const a = raw.scroll!;
          if (a.selector) await page.locator(a.selector).first().scrollIntoViewIfNeeded();
          else await page.evaluate((to) => window.scrollTo(0, to === 'top' ? 0 : document.body.scrollHeight), a.to ?? 'bottom');
          break;
        }
        case 'sleep': { await new Promise(r => setTimeout(r, Math.min(raw.sleep!.ms, 60000))); break; }
        case 'screenshot': {
          const a = raw.screenshot!;
          const buf = await page.screenshot({ fullPage: !!a.fullPage, ...(a.path ? { path: a.path } : {}) });
          detail = { path: a.path, bytes: buf.length };
          break;
        }
        case 'returnState': { lastReturnState = raw.returnState!; break; }
        default: throw new Error(`unknown step op: ${op}`);
      }
      results.push({ step: op, ok: true, detail, ms: Date.now() - t0 });
    } catch (err) {
      results.push({ step: op, ok: false, error: (err as Error).message, ms: Date.now() - t0 });
      Logger.warn('chain step failed', { op, error: (err as Error).message });
      if (!opts.continueOnError) { aborted = true; break; }
    }
  }

  const state = await snapshotState(page, lastReturnState ?? { url: true, title: true });
  return { steps: results, aborted, state, durationMs: Date.now() - start };
}
