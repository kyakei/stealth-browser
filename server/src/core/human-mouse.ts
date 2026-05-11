import { Page } from 'playwright';

/**
 * Human-like mouse movement: cubic-Bezier paths with eased timing, slight
 * overshoot-and-correct, and per-step micro-jitter — instead of teleporting the
 * cursor straight to a coordinate (which is what `page.mouse.click(x,y)` does
 * and what behavioral anti-bot / reCAPTCHA-v3 / Arkose notice). Algorithm is the
 * usual ghost-cursor recipe, kept dependency-free.
 *
 * Playwright doesn't expose the current cursor position, so we track it per-Page
 * in a WeakMap (seeded at the viewport centre on first use).
 */

const lastPos = new WeakMap<Page, { x: number; y: number }>();

function rand(min: number, max: number): number { return min + Math.random() * (max - min); }
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
// ease-in-out cubic
function ease(t: number): number { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

// Cubic Bezier point at parameter t given p0..p3.
function bezier(p0: number[], p1: number[], p2: number[], p3: number[], t: number): [number, number] {
  const u = 1 - t;
  const x = u * u * u * p0[0]! + 3 * u * u * t * p1[0]! + 3 * u * t * t * p2[0]! + t * t * t * p3[0]!;
  const y = u * u * u * p0[1]! + 3 * u * u * t * p1[1]! + 3 * u * t * t * p2[1]! + t * t * t * p3[1]!;
  return [x, y];
}

async function viewportCentre(page: Page): Promise<{ x: number; y: number }> {
  const vp = page.viewportSize() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => ({ width: 1280, height: 720 }));
  return { x: vp.width / 2, y: vp.height / 2 };
}

export interface HumanMoveOpts {
  /** How far the path is allowed to bow out perpendicular to the straight line, as a fraction of distance. */
  curviness?: number;     // default ~0.2
  /** Chance of an overshoot-and-correct at the end. */
  overshootChance?: number; // default 0.45
  /** Rough total travel time bounds (ms); actual scales with distance. */
  minDuration?: number;   // default 120
  maxDuration?: number;   // default 600
}

/** Move the cursor to (x,y) along a human-ish curved path. Updates the tracked position. */
export async function humanMove(page: Page, x: number, y: number, opts: HumanMoveOpts = {}): Promise<void> {
  const start = lastPos.get(page) ?? await viewportCentre(page);
  const curviness = opts.curviness ?? 0.2;
  const overshootChance = opts.overshootChance ?? 0.45;
  const minDur = opts.minDuration ?? 120;
  const maxDur = opts.maxDuration ?? 600;

  const dx = x - start.x, dy = y - start.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 2) { await page.mouse.move(x, y); lastPos.set(page, { x, y }); return; }

  // Optional overshoot: aim slightly past the target along the travel direction.
  const doOvershoot = Math.random() < overshootChance && dist > 60;
  const overshoot = doOvershoot
    ? { x: x + (dx / dist) * rand(4, 14), y: y + (dy / dist) * rand(4, 14) }
    : null;
  const aim = overshoot ?? { x, y };
  const adx = aim.x - start.x, ady = aim.y - start.y;
  const adist = Math.hypot(adx, ady) || 1;

  // Perpendicular unit vector, used to bow the two control points out by random amounts.
  const px = -ady / adist, py = adx / adist;
  const bow = dist * curviness;
  const c1 = [start.x + adx * 0.3 + px * rand(-bow, bow), start.y + ady * 0.3 + py * rand(-bow, bow)];
  const c2 = [start.x + adx * 0.7 + px * rand(-bow, bow), start.y + ady * 0.7 + py * rand(-bow, bow)];
  const p0 = [start.x, start.y], p3 = [aim.x, aim.y];

  const steps = clamp(Math.round(dist / 8), 10, 60);
  const dur = clamp(dist * rand(0.6, 1.4), minDur, maxDur);

  for (let i = 1; i <= steps; i++) {
    const tRaw = i / steps;
    const t = ease(tRaw);
    const [bx, by] = bezier(p0, c1, c2, p3, t);
    // micro-jitter, larger mid-flight, near-zero at the destination
    const j = (1 - tRaw) * rand(0, 1.6);
    await page.mouse.move(bx + rand(-j, j), by + rand(-j, j));
    await sleep((dur / steps) * rand(0.6, 1.4));
  }

  // Correct from the overshoot back onto the real target.
  if (overshoot) {
    const cSteps = clamp(Math.round(Math.hypot(x - aim.x, y - aim.y) / 3), 3, 10);
    for (let i = 1; i <= cSteps; i++) {
      const t = ease(i / cSteps);
      await page.mouse.move(aim.x + (x - aim.x) * t, aim.y + (y - aim.y) * t);
      await sleep(rand(6, 16));
    }
  }
  await page.mouse.move(x, y);
  lastPos.set(page, { x, y });
}

/** Move to (x,y) the human way, then click with a randomized button-hold. */
export async function humanClickAt(page: Page, x: number, y: number, opts: HumanMoveOpts & { holdMin?: number; holdMax?: number } = {}): Promise<void> {
  await humanMove(page, x, y, opts);
  await sleep(rand(20, 90));               // settle before pressing
  await page.mouse.down();
  await sleep(rand(opts.holdMin ?? 40, opts.holdMax ?? 140));
  await page.mouse.up();
}

/** Resolve a selector's box, pick a non-centre point inside it (jittered), and human-click it. */
export async function humanClickElement(page: Page, selector: string, opts: HumanMoveOpts & { holdMin?: number; holdMax?: number; timeout?: number } = {}): Promise<{ x: number; y: number }> {
  const el = await page.waitForSelector(selector, { timeout: opts.timeout ?? 10_000, state: 'visible' });
  if (!el) throw new Error(`selector not found / not visible: ${selector}`);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const box = await el.boundingBox();
  if (!box) throw new Error(`element has no box: ${selector}`);
  // Aim for a point biased toward the centre but not dead-centre.
  const x = box.x + box.width * rand(0.32, 0.68);
  const y = box.y + box.height * rand(0.32, 0.68);
  await humanClickAt(page, x, y, opts);
  return { x, y };
}

/** Seed/override the tracked cursor position (e.g. after a page navigation). */
export function setTrackedPosition(page: Page, x: number, y: number): void { lastPos.set(page, { x, y }); }
