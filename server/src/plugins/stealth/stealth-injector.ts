import { Page, BrowserContext } from 'playwright';
import { PluginInterface } from '@utils/types';
import { Logger } from '@utils/logger';

interface StealthConfig {
  enabled: boolean;
  level: 'low' | 'medium' | 'high';
  fingerprintRandomization: boolean;
  webglVendorSpoofing: boolean;
  userAgentRotation: boolean;
  customScripts?: string[];
}

export class StealthInjectorPlugin implements PluginInterface {
  public readonly name = 'stealth-injector';
  public readonly version = '2.0.0';
  public readonly description = 'Advanced stealth capabilities with fingerprint randomization and anti-detection';
  public readonly dependencies: string[] = [];

  public config: StealthConfig = {
    enabled: true,
    level: 'medium',
    fingerprintRandomization: true,
    webglVendorSpoofing: true,
    userAgentRotation: false
  };

  private stealthScripts = {
    // Core webdriver detection bypass
    webdriverBypass: `
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
      delete navigator.__proto__.webdriver;

      // Remove automation flag from chrome object
      if (window.chrome) {
        Object.defineProperty(window.chrome, 'runtime', {
          get: () => ({
            onConnect: undefined,
            onMessage: undefined,
          }),
        });
      }
    `,

    // Plugin and mime type spoofing
    pluginSpoofing: `
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          {
            0: { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: "Chrome PDF Plugin" },
            description: "Portable Document Format",
            filename: "internal-pdf-viewer",
            length: 1,
            name: "Chrome PDF Plugin"
          },
          {
            0: { type: "application/pdf", suffixes: "pdf", description: "", enabledPlugin: "Chrome PDF Viewer" },
            description: "",
            filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
            length: 1,
            name: "Chrome PDF Viewer"
          },
          {
            0: { type: "application/x-nacl", suffixes: "", description: "Native Client Executable", enabledPlugin: "Native Client" },
            1: { type: "application/x-pnacl", suffixes: "", description: "Portable Native Client Executable", enabledPlugin: "Native Client" },
            description: "",
            filename: "internal-nacl-plugin",
            length: 2,
            name: "Native Client"
          }
        ],
      });

      Object.defineProperty(navigator, 'mimeTypes', {
        get: () => [
          { type: "application/pdf", suffixes: "pdf", description: "", enabledPlugin: "Chrome PDF Viewer" },
          { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: "Chrome PDF Plugin" },
          { type: "application/x-nacl", suffixes: "", description: "Native Client Executable", enabledPlugin: "Native Client" },
          { type: "application/x-pnacl", suffixes: "", description: "Portable Native Client Executable", enabledPlugin: "Native Client" }
        ],
      });
    `,

    // Permissions API bypass
    permissionsAPI: `
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = function(parameters) {
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission });
        }
        return originalQuery.apply(this, arguments);
      };
    `,

    // Languages spoofing
    languagesSpoofing: `
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      Object.defineProperty(navigator, 'language', {
        get: () => 'en-US',
      });
    `,

    // Chrome object enhancement
    chromeEnhancement: `
      if (!window.chrome) {
        window.chrome = {};
      }

      Object.assign(window.chrome, {
        app: {
          isInstalled: false,
          InstallState: {
            DISABLED: 'disabled',
            INSTALLED: 'installed',
            NOT_INSTALLED: 'not_installed'
          },
          RunningState: {
            CANNOT_RUN: 'cannot_run',
            READY_TO_RUN: 'ready_to_run',
            RUNNING: 'running'
          }
        },
        runtime: {
          onConnect: undefined,
          onMessage: undefined,
          PlatformOs: {
            MAC: 'mac',
            WIN: 'win',
            ANDROID: 'android',
            CROS: 'cros',
            LINUX: 'linux',
            OPENBSD: 'openbsd'
          },
          PlatformArch: {
            ARM: 'arm',
            X86_32: 'x86-32',
            X86_64: 'x86-64'
          },
          PlatformNaclArch: {
            ARM: 'arm',
            X86_32: 'x86-32',
            X86_64: 'x86-64'
          }
        },
        loadTimes: () => ({
          requestTime: Date.now() / 1000 - Math.random() * 5,
          startLoadTime: Date.now() / 1000 - Math.random() * 3,
          commitLoadTime: Date.now() / 1000 - Math.random() * 2,
          finishDocumentLoadTime: Date.now() / 1000 - Math.random(),
          finishLoadTime: Date.now() / 1000,
          firstPaintTime: Date.now() / 1000 - Math.random(),
          firstPaintAfterLoadTime: 0,
          navigationType: 'Other',
          wasFetchedViaSpdy: false,
          wasNpnNegotiated: false,
          npnNegotiatedProtocol: 'unknown',
          wasAlternateProtocolAvailable: false,
          connectionInfo: 'unknown'
        }),
        csi: () => ({
          startE: Date.now(),
          onloadT: Date.now() + Math.random() * 1000,
          pageT: Date.now() - Math.random() * 1000,
          tran: 15
        })
      });
    `
  };

  public async initialize(config: StealthConfig): Promise<void> {
    this.config = { ...this.config, ...config };
    Logger.plugin(this.name, 'Stealth Injector Plugin initialized', {
      level: this.config.level,
      fingerprintRandomization: this.config.fingerprintRandomization
    });
  }

  public async beforePageCreate(page: Page): Promise<void> {
    if (!this.config.enabled) return;

    try {
      // Inject all stealth scripts based on level
      await this.injectStealthScripts(page);

      // Apply fingerprint randomization if enabled
      if (this.config.fingerprintRandomization) {
        await this.applyFingerprintRandomization(page);
      }

      Logger.plugin(this.name, 'Stealth scripts injected successfully');
    } catch (error) {
      Logger.error('Failed to inject stealth scripts', error);
    }
  }

  public async afterPageCreate(page: Page): Promise<void> {
    if (!this.config.enabled) return;

    try {
      // Set up additional stealth measures that require page to be created
      await this.setupAdvancedStealth(page);

      Logger.plugin(this.name, 'Advanced stealth measures applied');
    } catch (error) {
      Logger.error('Failed to apply advanced stealth measures', error);
    }
  }

  private async injectStealthScripts(page: Page): Promise<void> {
    const scriptsToInject = [
      this.stealthScripts.webdriverBypass,
      this.stealthScripts.pluginSpoofing,
      this.stealthScripts.permissionsAPI,
      this.stealthScripts.languagesSpoofing,
      this.stealthScripts.chromeEnhancement
    ];

    // Add level-specific scripts
    if (this.config.level === 'medium' || this.config.level === 'high') {
      scriptsToInject.push(this.generateWebGLSpoofing());
    }

    if (this.config.level === 'high') {
      scriptsToInject.push(this.generateCanvasFingerprinting());
      scriptsToInject.push(this.generateAdvancedNavigatorSpoofing());
    }

    // Add custom scripts if provided
    if (this.config.customScripts) {
      scriptsToInject.push(...this.config.customScripts);
    }

    // Inject all scripts
    for (const script of scriptsToInject) {
      await page.addInitScript(script);
    }
  }

  private async applyFingerprintRandomization(page: Page): Promise<void> {
    const randomizationScript = `
      // Randomize screen properties
      Object.defineProperty(screen, 'availWidth', {
        get: () => ${1920 + Math.floor(Math.random() * 200) - 100}
      });

      Object.defineProperty(screen, 'availHeight', {
        get: () => ${1080 + Math.floor(Math.random() * 100) - 50}
      });

      Object.defineProperty(screen, 'colorDepth', {
        get: () => ${Math.random() > 0.5 ? 24 : 32}
      });

      // Randomize timezone
      const timezones = [
        'America/New_York', 'America/Los_Angeles', 'America/Chicago',
        'Europe/London', 'Europe/Berlin', 'Asia/Tokyo'
      ];
      Object.defineProperty(Intl.DateTimeFormat.prototype, 'resolvedOptions', {
        value: function() {
          const options = {
            timeZone: timezones[Math.floor(Math.random() * timezones.length)],
            locale: 'en-US'
          };
          return options;
        }
      });

      // Randomize hardware concurrency
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => ${2 + Math.floor(Math.random() * 14)} // 2-16 cores
      });

      // Randomize device memory
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => ${Math.pow(2, Math.floor(Math.random() * 3) + 2)} // 4, 8, or 16 GB
      });
    `;

    await page.addInitScript(randomizationScript);
  }

  private generateWebGLSpoofing(): string {
    const vendors = ['Intel Inc.', 'NVIDIA Corporation', 'AMD', 'Qualcomm'];
    const renderers = [
      'Intel(R) HD Graphics 620',
      'NVIDIA GeForce GTX 1060',
      'AMD Radeon RX 580',
      'Intel(R) UHD Graphics 630'
    ];

    const randomVendor = vendors[Math.floor(Math.random() * vendors.length)];
    const randomRenderer = renderers[Math.floor(Math.random() * renderers.length)];

    return `
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return '${randomVendor}';
        if (parameter === 37446) return '${randomRenderer}';
        return getParameter.call(this, parameter);
      };

      const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return '${randomVendor}';
        if (parameter === 37446) return '${randomRenderer}';
        return getParameter2.call(this, parameter);
      };
    `;
  }

  private generateCanvasFingerprinting(): string {
    return `
      const toDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function() {
        // Add slight noise to canvas fingerprinting
        const context = this.getContext('2d');
        if (context) {
          const imageData = context.getImageData(0, 0, this.width, this.height);
          const data = imageData.data;

          // Add minimal noise to avoid breaking functionality
          for (let i = 0; i < data.length; i += 4) {
            if (Math.random() < 0.01) { // 1% chance to modify pixel
              data[i] = Math.min(255, data[i] + (Math.random() - 0.5) * 2);
              data[i + 1] = Math.min(255, data[i + 1] + (Math.random() - 0.5) * 2);
              data[i + 2] = Math.min(255, data[i + 2] + (Math.random() - 0.5) * 2);
            }
          }

          context.putImageData(imageData, 0, 0);
        }

        return toDataURL.apply(this, arguments);
      };
    `;
  }

  private generateAdvancedNavigatorSpoofing(): string {
    return `
      // Spoof additional navigator properties
      Object.defineProperty(navigator, 'platform', {
        get: () => {
          const platforms = ['Win32', 'MacIntel', 'Linux x86_64'];
          return platforms[Math.floor(Math.random() * platforms.length)];
        }
      });

      Object.defineProperty(navigator, 'vendor', {
        get: () => 'Google Inc.'
      });

      Object.defineProperty(navigator, 'vendorSub', {
        get: () => ''
      });

      Object.defineProperty(navigator, 'productSub', {
        get: () => '20030107'
      });

      // Spoof connection information
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: 50,
          downlink: 10,
          saveData: false
        })
      });

      // Spoof battery information to avoid fingerprinting
      Object.defineProperty(navigator, 'getBattery', {
        value: () => Promise.resolve({
          charging: true,
          chargingTime: Infinity,
          dischargingTime: Infinity,
          level: Math.random()
        })
      });
    `;
  }

  private async setupAdvancedStealth(page: Page): Promise<void> {
    // Block common bot detection resources
    await page.route('**/*', (route, request) => {
      const url = request.url();
      const blockedDomains = [
        'datadome.co',
        'perimeterx.net',
        'distilnetworks.com',
        'botdetect.com'
      ];

      if (blockedDomains.some(domain => url.includes(domain))) {
        Logger.debug(`Blocked bot detection request: ${url}`);
        route.abort();
        return;
      }

      route.continue();
    });

    // Modify headers to look more human
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1'
    });
  }

  public async cleanup(): Promise<void> {
    Logger.plugin(this.name, 'Stealth Injector Plugin cleaned up');
  }
}

export default StealthInjectorPlugin;