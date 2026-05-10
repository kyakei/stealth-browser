import axios from 'axios';
import { Page } from 'playwright';
import { Logger } from '@utils/logger';

const API_BASE = 'https://api.2captcha.com';
const SOFT_ID = 0;

export type CaptchaType =
  | 'recaptcha_v2'
  | 'recaptcha_v2_invisible'
  | 'recaptcha_v3'
  | 'hcaptcha'
  | 'hcaptcha_invisible'
  | 'turnstile'
  | 'datadome'
  | 'aws_waf'
  | 'mtcaptcha'
  | 'friendly';

export interface ProxySpec {
  type: 'http' | 'https' | 'socks4' | 'socks5';
  address: string;
  port: number;
  login?: string | undefined;
  password?: string | undefined;
}

export interface SolveOpts {
  type?: CaptchaType | undefined;
  sitekey?: string | undefined;
  pageUrl?: string | undefined;
  action?: string | undefined;
  minScore?: number | undefined;
  cdata?: string | undefined;
  captchaUrl?: string | undefined;
  userAgent?: string | undefined;
  proxy?: ProxySpec | undefined;
  enterprise?: boolean | undefined;
  isInvisible?: boolean | undefined;
  maxWaitSeconds?: number | undefined;
  pollIntervalMs?: number | undefined;
  apiKey?: string | undefined;
  inject?: boolean | undefined;
}

export interface DetectResult {
  type: CaptchaType | 'unknown';
  sitekey?: string | undefined;
  iframeUrl?: string | undefined;
  action?: string | undefined;
  evidence: string[];
}

export interface SolveResult {
  type: CaptchaType;
  sitekey?: string | undefined;
  pageUrl: string;
  taskId: number;
  token?: string | undefined;
  cookie?: string | undefined;
  injected: boolean;
  cost?: string | undefined;
  ip?: string | undefined;
  durationMs: number;
}

const PROXYLESS_TASK_TYPE: Record<string, string> = {
  recaptcha_v2: 'RecaptchaV2TaskProxyless',
  recaptcha_v2_invisible: 'RecaptchaV2TaskProxyless',
  recaptcha_v3: 'RecaptchaV3TaskProxyless',
  hcaptcha: 'HCaptchaTaskProxyless',
  hcaptcha_invisible: 'HCaptchaTaskProxyless',
  turnstile: 'TurnstileTaskProxyless',
  mtcaptcha: 'MtCaptchaTaskProxyless',
  friendly: 'FriendlyCaptchaTaskProxyless',
};

const PROXIED_TASK_TYPE: Record<string, string> = {
  recaptcha_v2: 'RecaptchaV2Task',
  recaptcha_v2_invisible: 'RecaptchaV2Task',
  recaptcha_v3: 'RecaptchaV3Task',
  hcaptcha: 'HCaptchaTask',
  hcaptcha_invisible: 'HCaptchaTask',
  turnstile: 'TurnstileTask',
  datadome: 'DataDomeSliderTask',
  aws_waf: 'AmazonTask',
  mtcaptcha: 'MtCaptchaTask',
  friendly: 'FriendlyCaptchaTask',
};

export class TwoCaptchaError extends Error {
  errorCode?: string | undefined;
  errorId?: number | undefined;
  constructor(msg: string, errorCode?: string, errorId?: number) {
    super(msg);
    this.errorCode = errorCode;
    this.errorId = errorId;
  }
}

export class CaptchaSolver {
  private resolveKey(opts?: { apiKey?: string | undefined }): string {
    const key = opts?.apiKey || process.env.TWOCAPTCHA_API_KEY;
    if (!key) {
      throw new TwoCaptchaError(
        'TWOCAPTCHA_API_KEY missing. Set in server/.env or pass apiKey arg.',
        'MISSING_KEY'
      );
    }
    return key;
  }

  public async getBalance(apiKey?: string): Promise<{ balance: number }> {
    const clientKey = this.resolveKey({ apiKey });
    const r = await axios.post(`${API_BASE}/getBalance`, { clientKey }, { timeout: 15_000 });
    if (r.data?.errorId) {
      throw new TwoCaptchaError(r.data.errorDescription || 'getBalance failed', r.data.errorCode, r.data.errorId);
    }
    return { balance: Number(r.data.balance) };
  }

  public async detect(page: Page): Promise<DetectResult> {
    const result = await page.evaluate(DETECTOR_JS) as DetectResult;
    return result;
  }

  public async solve(page: Page, opts: SolveOpts = {}): Promise<SolveResult> {
    const start = Date.now();
    const inject = opts.inject !== false;

    let type = opts.type;
    let sitekey = opts.sitekey;
    let action = opts.action;
    let captchaUrl = opts.captchaUrl;
    const pageUrl = opts.pageUrl || page.url();

    if (!type || !sitekey) {
      const det = await this.detect(page);
      if (det.type === 'unknown') {
        throw new TwoCaptchaError(
          `auto-detect failed; pass type+sitekey explicitly. evidence=${JSON.stringify(det.evidence)}`,
          'NO_DETECT'
        );
      }
      type = type || (det.type as CaptchaType);
      sitekey = sitekey || det.sitekey;
      action = action || det.action;
      if (det.type === 'datadome') captchaUrl = captchaUrl || det.iframeUrl;
    }

    if (type === 'datadome') {
      if (!opts.proxy) throw new TwoCaptchaError('DataDome requires `proxy` (DataDomeSliderTask is not proxyless).', 'PROXY_REQUIRED');
      if (!captchaUrl) throw new TwoCaptchaError('DataDome requires `captchaUrl` (the captcha-delivery iframe URL).', 'CAPTCHA_URL_REQUIRED');
    }

    if (type !== 'datadome' && type !== 'aws_waf' && !sitekey) {
      throw new TwoCaptchaError(`sitekey required for type=${type}`, 'SITEKEY_REQUIRED');
    }

    const task = this.buildTask(type, { sitekey, pageUrl, action, minScore: opts.minScore, cdata: opts.cdata, captchaUrl, userAgent: opts.userAgent, proxy: opts.proxy, enterprise: opts.enterprise, isInvisible: opts.isInvisible });
    const clientKey = this.resolveKey({ apiKey: opts.apiKey });

    Logger.info('captcha: createTask', { type, taskType: task.type, pageUrl, sitekey });
    const taskId = await this.createTask(clientKey, task);
    const result = await this.pollResult(clientKey, taskId, opts.maxWaitSeconds ?? 180, opts.pollIntervalMs ?? 5_000);
    const durationMs = Date.now() - start;

    const out: SolveResult = {
      type,
      sitekey,
      pageUrl,
      taskId,
      cost: result.cost,
      ip: result.ip,
      durationMs,
      injected: false,
    };

    const sol = result.solution || {};
    if (type === 'datadome') {
      out.cookie = sol.cookie;
    } else if (type === 'recaptcha_v2' || type === 'recaptcha_v2_invisible' || type === 'recaptcha_v3') {
      out.token = sol.gRecaptchaResponse || sol.token;
    } else if (type === 'hcaptcha' || type === 'hcaptcha_invisible') {
      out.token = sol.token || sol.gRecaptchaResponse;
    } else if (type === 'turnstile') {
      out.token = sol.token;
    } else if (type === 'mtcaptcha') {
      out.token = sol.token;
    } else if (type === 'friendly') {
      out.token = sol.token;
    } else if (type === 'aws_waf') {
      out.token = sol.token || sol.captcha_voucher || JSON.stringify(sol);
    }

    if (inject) {
      if (type === 'datadome' && out.cookie) {
        await this.injectDataDomeCookie(page, out.cookie);
        out.injected = true;
      } else if (out.token) {
        const ok = await this.injectToken(page, type, out.token);
        out.injected = ok;
      }
    }

    return out;
  }

  private buildTask(type: CaptchaType, p: {
    sitekey?: string | undefined; pageUrl: string; action?: string | undefined; minScore?: number | undefined; cdata?: string | undefined;
    captchaUrl?: string | undefined; userAgent?: string | undefined; proxy?: ProxySpec | undefined; enterprise?: boolean | undefined; isInvisible?: boolean | undefined;
  }): any {
    const taskName = p.proxy ? PROXIED_TASK_TYPE[type] : (PROXYLESS_TASK_TYPE[type] || PROXIED_TASK_TYPE[type]);
    if (!taskName) throw new TwoCaptchaError(`unsupported type: ${type}`, 'UNSUPPORTED_TYPE');

    const t: any = { type: taskName, websiteURL: p.pageUrl };
    if (p.sitekey) t.websiteKey = p.sitekey;

    if (type === 'recaptcha_v2_invisible') t.isInvisible = true;
    if (type === 'hcaptcha_invisible') t.isInvisible = true;
    if (p.isInvisible !== undefined) t.isInvisible = p.isInvisible;
    if (p.enterprise) t.isEnterprise = true;

    if (type === 'recaptcha_v3') {
      if (p.action) t.pageAction = p.action;
      if (p.minScore !== undefined) t.minScore = p.minScore;
    }

    if (type === 'turnstile') {
      if (p.action) t.action = p.action;
      if (p.cdata) t.data = p.cdata;
    }

    if (type === 'datadome') {
      if (p.captchaUrl) t.captchaUrl = p.captchaUrl;
      if (p.userAgent) t.userAgent = p.userAgent;
    }

    if (p.proxy) {
      t.proxyType = p.proxy.type;
      t.proxyAddress = p.proxy.address;
      t.proxyPort = p.proxy.port;
      if (p.proxy.login) t.proxyLogin = p.proxy.login;
      if (p.proxy.password) t.proxyPassword = p.proxy.password;
      if (p.userAgent) t.userAgent = p.userAgent;
    }

    return t;
  }

  private async createTask(clientKey: string, task: any): Promise<number> {
    const r = await axios.post(`${API_BASE}/createTask`, { clientKey, task, softId: SOFT_ID }, { timeout: 30_000 });
    if (r.data?.errorId) {
      throw new TwoCaptchaError(r.data.errorDescription || 'createTask failed', r.data.errorCode, r.data.errorId);
    }
    return r.data.taskId as number;
  }

  private async pollResult(clientKey: string, taskId: number, maxWaitSec: number, intervalMs: number): Promise<any> {
    const deadline = Date.now() + maxWaitSec * 1000;
    let firstWait = true;
    while (Date.now() < deadline) {
      if (firstWait) {
        await sleep(Math.min(15_000, intervalMs * 2));
        firstWait = false;
      } else {
        await sleep(intervalMs);
      }
      const r = await axios.post(`${API_BASE}/getTaskResult`, { clientKey, taskId }, { timeout: 15_000 });
      if (r.data?.errorId) {
        throw new TwoCaptchaError(r.data.errorDescription || 'getTaskResult failed', r.data.errorCode, r.data.errorId);
      }
      if (r.data.status === 'ready') return r.data;
    }
    throw new TwoCaptchaError(`captcha poll timeout after ${maxWaitSec}s (taskId=${taskId})`, 'TIMEOUT');
  }

  private async injectToken(page: Page, type: CaptchaType, token: string): Promise<boolean> {
    return await page.evaluate(([t, tok]) => {
      const T = String(t);
      const TOK = String(tok);
      const setTextarea = (sel: string) => {
        const els = document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(sel);
        let n = 0;
        els.forEach(el => {
          (el as any).value = TOK;
          if (el.tagName === 'TEXTAREA') (el as HTMLTextAreaElement).innerHTML = TOK;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          n++;
        });
        return n;
      };

      const fireCallback = (cb: any, tok: string) => {
        try {
          if (typeof cb === 'function') { cb(tok); return true; }
          if (typeof cb === 'string' && (window as any)[cb]) { (window as any)[cb](tok); return true; }
        } catch {}
        return false;
      };

      let injected = 0;

      if (T === 'recaptcha_v2' || T === 'recaptcha_v2_invisible' || T === 'recaptcha_v3') {
        injected += setTextarea('textarea[name="g-recaptcha-response"]');
        injected += setTextarea('textarea#g-recaptcha-response');
        injected += setTextarea('input[name="g-recaptcha-response"]');
        const cfg = (window as any).___grecaptcha_cfg;
        if (cfg && cfg.clients) {
          for (const c of Object.values<any>(cfg.clients)) {
            if (!c) continue;
            for (const v1 of Object.values<any>(c)) {
              if (!v1 || typeof v1 !== 'object') continue;
              for (const v2 of Object.values<any>(v1)) {
                if (v2 && typeof v2 === 'object' && 'callback' in v2) {
                  if (fireCallback(v2.callback, TOK)) injected++;
                }
              }
            }
          }
        }
      }

      if (T === 'hcaptcha' || T === 'hcaptcha_invisible') {
        injected += setTextarea('textarea[name="h-captcha-response"]');
        injected += setTextarea('textarea[name="g-recaptcha-response"]');
        injected += setTextarea('textarea#h-captcha-response');
        const widgets = document.querySelectorAll<HTMLElement>('.h-captcha[data-callback], [data-callback][data-sitekey]');
        widgets.forEach(w => {
          const cb = w.getAttribute('data-callback');
          if (cb && fireCallback(cb, TOK)) injected++;
        });
      }

      if (T === 'turnstile') {
        injected += setTextarea('input[name="cf-turnstile-response"]');
        injected += setTextarea('textarea[name="cf-turnstile-response"]');
        const widgets = document.querySelectorAll<HTMLElement>('.cf-turnstile[data-callback], [data-callback][data-sitekey]');
        widgets.forEach(w => {
          const cb = w.getAttribute('data-callback');
          if (cb && fireCallback(cb, TOK)) injected++;
        });
        try {
          const ts = (window as any).turnstile;
          if (ts && typeof ts.getResponse === 'function') {
            (window as any).__turnstile_token__ = TOK;
          }
        } catch {}
      }

      if (T === 'mtcaptcha') {
        injected += setTextarea('input[name="mtcaptcha-verifiedtoken"]');
        injected += setTextarea('input[name*="mtcaptcha"]');
      }

      if (T === 'friendly') {
        injected += setTextarea('input[name="frc-captcha-solution"]');
        injected += setTextarea('input[name="frc-captcha-response"]');
      }

      if (T === 'aws_waf') {
        injected += setTextarea('input[name="captcha-token"]');
      }

      return injected > 0;
    }, [type, token]);
  }

  private async injectDataDomeCookie(page: Page, cookieStr: string): Promise<void> {
    const ctx = page.context();
    const url = new URL(page.url());
    const baseDomain = url.hostname.split('.').slice(-2).join('.');
    const parts = cookieStr.split(/;\s*/);
    const kv = parts[0]?.split('=');
    if (!kv || kv.length < 2) throw new TwoCaptchaError('invalid datadome cookie format', 'BAD_COOKIE');
    const name = kv[0]!;
    const value = parts[0]!.substring(name.length + 1);
    const cookie: any = {
      name,
      value,
      domain: '.' + baseDomain,
      path: '/',
      sameSite: 'Lax',
      secure: true,
      httpOnly: false,
    };
    for (const p of parts.slice(1)) {
      const [k, v] = p.split('=');
      const keyL = k?.toLowerCase();
      if (keyL === 'domain' && v) cookie.domain = v;
      if (keyL === 'path' && v) cookie.path = v;
      if (keyL === 'samesite' && v) cookie.sameSite = v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
      if (keyL === 'secure') cookie.secure = true;
      if (keyL === 'httponly') cookie.httpOnly = true;
      if (keyL === 'max-age' && v) cookie.expires = Math.floor(Date.now() / 1000) + Number(v);
    }
    await ctx.addCookies([cookie]);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  }
}

function sleep(ms: number) {
  return new Promise<void>(res => setTimeout(res, ms));
}

const DETECTOR_JS = `(() => {
  const evidence = [];
  const out = { type: 'unknown', evidence };

  // Cloudflare Turnstile
  const tsEl = document.querySelector('.cf-turnstile[data-sitekey], [data-sitekey][data-action], [data-sitekey][data-cdata]');
  const tsIframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
  if (tsEl || tsIframe) {
    out.type = 'turnstile';
    if (tsEl) {
      out.sitekey = tsEl.getAttribute('data-sitekey') || undefined;
      out.action = tsEl.getAttribute('data-action') || undefined;
    } else {
      const m = (tsIframe && tsIframe.getAttribute('src') || '').match(/[?&]k=([^&]+)/);
      if (m) out.sitekey = m[1];
    }
    evidence.push('cf-turnstile element found');
    return out;
  }

  // hCaptcha
  const hcEl = document.querySelector('.h-captcha[data-sitekey], [data-hcaptcha-widget-id]');
  const hcIframe = document.querySelector('iframe[src*="hcaptcha.com"]');
  if (hcEl || hcIframe) {
    out.type = 'hcaptcha';
    if (hcEl) out.sitekey = hcEl.getAttribute('data-sitekey') || undefined;
    if (!out.sitekey && hcIframe) {
      const m = hcIframe.getAttribute('src').match(/[?&]sitekey=([^&]+)/);
      if (m) out.sitekey = m[1];
    }
    if (hcEl && hcEl.getAttribute('data-size') === 'invisible') out.type = 'hcaptcha_invisible';
    evidence.push('hcaptcha element found');
    return out;
  }

  // reCAPTCHA (anchor iframe = v2 checkbox/invisible; v3 has no anchor iframe usually)
  const rcEl = document.querySelector('.g-recaptcha[data-sitekey]');
  const rcAnchor = document.querySelector('iframe[src*="google.com/recaptcha/api2/anchor"], iframe[src*="google.com/recaptcha/enterprise/anchor"]');
  if (rcAnchor) {
    out.type = 'recaptcha_v2';
    const m = rcAnchor.getAttribute('src').match(/[?&]k=([^&]+)/);
    if (m) out.sitekey = m[1];
    if ((rcAnchor.getAttribute('src') || '').includes('size=invisible')) out.type = 'recaptcha_v2_invisible';
    evidence.push('recaptcha v2 anchor iframe found');
    return out;
  }
  if (rcEl) {
    out.type = 'recaptcha_v2';
    out.sitekey = rcEl.getAttribute('data-sitekey') || undefined;
    if (rcEl.getAttribute('data-size') === 'invisible') out.type = 'recaptcha_v2_invisible';
    evidence.push('.g-recaptcha element found');
    return out;
  }
  // v3: look for grecaptcha render script with sitekey on it
  const rcV3 = document.querySelector('script[src*="recaptcha/api.js?render="], script[src*="recaptcha/enterprise.js?render="]');
  if (rcV3) {
    const m = rcV3.getAttribute('src').match(/[?&]render=([^&]+)/);
    if (m && m[1] !== 'explicit') {
      out.type = 'recaptcha_v3';
      out.sitekey = m[1];
      evidence.push('recaptcha v3 script tag detected');
      return out;
    }
  }

  // DataDome
  const ddIframe = document.querySelector('iframe[src*="captcha-delivery.com"], iframe[src*="geo.captcha-delivery.com"]');
  if (ddIframe) {
    out.type = 'datadome';
    out.iframeUrl = ddIframe.getAttribute('src') || undefined;
    evidence.push('datadome iframe found');
    return out;
  }

  // MTCaptcha
  const mtEl = document.querySelector('[data-mt-key], .mtcaptcha');
  if (mtEl) {
    out.type = 'mtcaptcha';
    out.sitekey = mtEl.getAttribute('data-mt-key') || undefined;
    evidence.push('mtcaptcha element found');
    return out;
  }

  // Friendly Captcha
  const frEl = document.querySelector('.frc-captcha[data-sitekey]');
  if (frEl) {
    out.type = 'friendly';
    out.sitekey = frEl.getAttribute('data-sitekey') || undefined;
    evidence.push('friendly captcha element found');
    return out;
  }

  // AWS WAF
  if (document.querySelector('script[src*="awswaf"]') || document.body.innerHTML.includes('awswafCaptchaToken')) {
    out.type = 'aws_waf';
    evidence.push('awswaf script/global detected');
    return out;
  }

  return out;
})()`;
