/**
 * Compact ad / analytics / tracker domain blocklist. Not the full 3,500-entry
 * Scrapling list — just the high-traffic ones that dominate the network capture
 * on enterprise sites. Blocking these = faster page loads + a cleaner network
 * log (you stop wading through 40 beacon hits to find the one API call).
 *
 * Subdomain-suffix matched: blocking "doubleclick.net" also blocks
 * "stats.g.doubleclick.net" etc.
 */
export const AD_DOMAINS: ReadonlySet<string> = new Set([
  // Google ads / analytics
  'doubleclick.net', 'googleadservices.com', 'googlesyndication.com', 'google-analytics.com',
  'googletagmanager.com', 'googletagservices.com', 'analytics.google.com', 'g.doubleclick.net',
  'adservice.google.com', 'pagead2.googlesyndication.com', 'partner.googleadservices.com',
  // Meta / social pixels
  'connect.facebook.net', 'facebook.com/tr', 'pixel.facebook.com', 'analytics.twitter.com',
  'static.ads-twitter.com', 'ads.linkedin.com', 'px.ads.linkedin.com', 'snap.licdn.com',
  'platform.twitter.com',
  // Analytics SaaS
  'segment.io', 'segment.com', 'cdn.segment.com', 'api.segment.io', 'mixpanel.com', 'api.mixpanel.com',
  'amplitude.com', 'api.amplitude.com', 'cdn.amplitude.com', 'heap.io', 'heapanalytics.com',
  'fullstory.com', 'rs.fullstory.com', 'hotjar.com', 'static.hotjar.com', 'script.hotjar.com',
  'mouseflow.com', 'clarity.ms', 'logrocket.com', 'cdn.lr-ingest.io', 'r.lr-ingest.io',
  'matomo.cloud', 'plausible.io', 'posthog.com', 'app.posthog.com',
  // Tag managers / consent
  'cookielaw.org', 'onetrust.com', 'cdn.cookielaw.org', 'consent.cookiebot.com', 'cookiebot.com',
  'trustarc.com', 'consensu.org', 'quantcast.com', 'quantserve.com',
  // Ad exchanges / DSPs
  'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'criteo.com', 'criteo.net',
  'taboola.com', 'outbrain.com', 'sharethrough.com', 'casalemedia.com', 'rlcdn.com', 'bidswitch.net',
  'adsrvr.org', '3lift.com', 'smartadserver.com', 'yieldmo.com', 'media.net', 'amazon-adsystem.com',
  'scorecardresearch.com', 'sb.scorecardresearch.com', 'bing.com/bat', 'bat.bing.com',
  // RUM / perf beacons / misc trackers
  'newrelic.com', 'nr-data.net', 'bam.nr-data.net', 'js-agent.newrelic.com', 'cdn.nr-data.net',
  'datadoghq.com', 'browser-intake-datadoghq.com', 'sentry.io', 'ingest.sentry.io',
  'bugsnag.com', 'sessions.bugsnag.com', 'cloudflareinsights.com', 'static.cloudflareinsights.com',
  'demdex.net', 'omtrdc.net', 'adobedtm.com', 'everesttech.net', 'tt.omtrdc.net',
  'branch.io', 'app.link', 'bnc.lt', 'appsflyer.com', 'adjust.com', 'app.adjust.com',
  'intercom.io', 'widget.intercom.io', 'js.intercomcdn.com', 'drift.com', 'js.driftt.com',
  'zdassets.com', 'zopim.com', 'tawk.to', 'embed.tawk.to',
]);
