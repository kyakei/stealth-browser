import { spawn, ChildProcess } from 'child_process';
import { Logger } from '@utils/logger';

export interface DisplayConfig {
  /** X DISPLAY that Xvfb + Chromium use. Default `:99`. */
  display: string;
  /** VNC port x11vnc listens on (usually localhost-only). */
  vncPort: number;
  /** HTTP port websockify serves noVNC + the WebSocket upgrade on. */
  webPort: number;
  /** Filesystem path to noVNC web assets. Debian package default. */
  novncDir: string;
  /** x11vnc binary location. */
  x11vncBin: string;
  /** websockify binary location. */
  websockifyBin: string;
  /** Optional password file for VNC. If unset, `-nopw` is used (LAN/localhost only). */
  passwordFile?: string;
}

export interface DisplayStatus {
  visible: boolean;
  display: string;
  vncPort?: number;
  webPort?: number;
  url?: string;
  x11vncPid?: number;
  websockifyPid?: number;
}

const DEFAULT_CONFIG: DisplayConfig = {
  display: process.env.DISPLAY || ':99',
  vncPort: 5900,
  webPort: 6080,
  novncDir: '/usr/share/novnc',
  x11vncBin: '/usr/bin/x11vnc',
  websockifyBin: '/usr/bin/websockify'
};

/**
 * Handles on-demand "make the headless Chromium visible" via x11vnc + websockify.
 *
 * Chromium always runs under the Xvfb DISPLAY controlled by the parent process
 * (set via env before spawning node). When the AI hits a human-only gate
 * (Turnstile interactive challenge, MFA, KYB form), call show() to spawn
 * x11vnc + websockify and hand the user a noVNC URL. When done, hide().
 *
 * Sessions, cookies, and in-progress navigation survive show/hide because we're
 * never restarting Chromium — just toggling the visual transport.
 */
export class DisplayManager {
  private config: DisplayConfig;
  private x11vncProc: ChildProcess | null = null;
  private websockifyProc: ChildProcess | null = null;

  constructor(config: Partial<DisplayConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public getStatus(): DisplayStatus {
    const visible = this.isAlive(this.x11vncProc) && this.isAlive(this.websockifyProc);
    const out: DisplayStatus = {
      visible,
      display: this.config.display
    };
    if (visible) {
      out.vncPort = this.config.vncPort;
      out.webPort = this.config.webPort;
      out.url = this.buildUrl();
      if (this.x11vncProc?.pid) out.x11vncPid = this.x11vncProc.pid;
      if (this.websockifyProc?.pid) out.websockifyPid = this.websockifyProc.pid;
    }
    return out;
  }

  public async show(): Promise<DisplayStatus> {
    if (this.isAlive(this.x11vncProc) && this.isAlive(this.websockifyProc)) {
      return this.getStatus();
    }

    // Clean up any half-dead prior state before starting fresh.
    await this.hide();

    Logger.info('DisplayManager.show: starting x11vnc + websockify', {
      display: this.config.display,
      vncPort: this.config.vncPort,
      webPort: this.config.webPort
    });

    this.x11vncProc = this.spawnX11vnc();
    // Small delay so x11vnc is listening before websockify attaches.
    await new Promise(r => setTimeout(r, 500));
    this.websockifyProc = this.spawnWebsockify();

    // Let websockify bind before returning the URL.
    await new Promise(r => setTimeout(r, 300));

    return this.getStatus();
  }

  public async hide(): Promise<DisplayStatus> {
    if (this.websockifyProc) {
      try { this.websockifyProc.kill('SIGTERM'); } catch {}
      this.websockifyProc = null;
    }
    if (this.x11vncProc) {
      try { this.x11vncProc.kill('SIGTERM'); } catch {}
      this.x11vncProc = null;
    }
    return this.getStatus();
  }

  public async shutdown(): Promise<void> {
    await this.hide();
  }

  private spawnX11vnc(): ChildProcess {
    // NOTE: we DO NOT pass `-bg` here — that makes x11vnc fork into the background
    // and the spawn'd PID would die immediately, orphaning our child. Instead we
    // keep it in the foreground with stdio:'ignore' so node's ChildProcess stays
    // accurate for isAlive() / SIGTERM.
    const args: string[] = [
      '-display', this.config.display,
      '-rfbport', String(this.config.vncPort),
      '-localhost',       // only accept connections from localhost — websockify is the proxy
      '-forever',         // don't exit on client disconnect
      '-shared',          // allow multiple concurrent viewers
      '-cursor', 'arrow', // send a real cursor to the VNC client — essential for human takeover
      '-quiet',
      '-o', '/tmp/x11vnc.log'
    ];
    if (this.config.passwordFile) {
      args.push('-rfbauth', this.config.passwordFile);
    } else {
      args.push('-nopw');
    }
    const proc = spawn(this.config.x11vncBin, args, { stdio: 'ignore', detached: false });
    proc.on('exit', (code, signal) => {
      Logger.info(`x11vnc exited (code=${code} signal=${signal})`);
    });
    proc.on('error', err => {
      Logger.error('x11vnc failed to start', err);
    });
    return proc;
  }

  private spawnWebsockify(): ChildProcess {
    const target = `localhost:${this.config.vncPort}`;
    const args: string[] = [
      `--web=${this.config.novncDir}`,
      String(this.config.webPort),
      target
    ];
    const proc = spawn(this.config.websockifyBin, args, { stdio: 'ignore', detached: false });
    proc.on('exit', (code, signal) => {
      Logger.info(`websockify exited (code=${code} signal=${signal})`);
    });
    proc.on('error', err => {
      Logger.error('websockify failed to start', err);
    });
    return proc;
  }

  private buildUrl(): string {
    // noVNC accepts these query params; `autoconnect` + `resize=scale` makes
    // the viewer just Work when the user opens the URL.
    const params = new URLSearchParams({
      autoconnect: '1',
      resize: 'scale',
      reconnect: '1',
      path: 'websockify'
    });
    return `http://localhost:${this.config.webPort}/vnc.html?${params.toString()}`;
  }

  private isAlive(proc: ChildProcess | null): boolean {
    if (!proc) return false;
    if (proc.exitCode != null) return false;
    if (proc.killed) return false;
    return true;
  }
}
