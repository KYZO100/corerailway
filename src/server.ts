import { OMSSServer, ProxyService } from '@omss/framework';
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { knownThirdPartyProxies } from './thirdPartyProxies.js';
import { streamPatterns } from './streamPatterns.js';
import { registerVidLinkProxy } from './vidlinkProxy.js';
import { registerCinezoProxy } from './cinezoProxy.js';
import { ShowboxProvider } from './providers/showbox/showbox.js';
import { MovyProvider } from './providers/movy/movy.js';
import { BoomflixProvider } from './providers/boomflix/boomflix.js';
import { VidriftProvider } from './providers/vidrift/vidrift.js';
import { VixSrcProvider } from './providers/vixsrc/vixsrc.js';
import { CinezoProvider } from './providers/cinezo/cinezo.js';
import { VaplayerProvider } from './providers/vaplayer/vaplayer.js';

const __filename = typeof import.meta !== 'undefined' && import.meta.url ? fileURLToPath(import.meta.url) : '';
const __dirname = __filename ? path.dirname(__filename) : '';

function directUrlFromProxyUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const data = parsed.searchParams.get('data');
        if (!data) return url;

        const proxyData = ProxyService.decodeProxyData(data);
        const cinezoTarget = proxyData.headers?.['X-Cinezo-Target'];
        return cinezoTarget || proxyData.url;
    } catch {
        return url;
    }
}

function replaceProxyUrlsInResponse(payload: string): string {
    try {
        const body = JSON.parse(payload) as {
            sources?: Array<{ url?: string }>;
            subtitles?: Array<{ url?: string }>;
        };
        const entries = [...(body.sources ?? []), ...(body.subtitles ?? [])];
        for (const entry of entries) {
            if (typeof entry.url === 'string') {
                entry.url = directUrlFromProxyUrl(entry.url);
            }
        }
        return JSON.stringify(body);
    } catch {
        return payload;
    }
}

// Keep the strongest direct-play providers first. The client still receives
// every available fallback, but the best no-proxy options are selected first.
const providerPriority = ['showbox', 'vixsrc', 'boomflix', 'vidrift', 'movy'];

function registerProviders(server: OMSSServer, env: Record<string, string | undefined>) {
    const registry = server.getRegistry();
    registry.register(new ShowboxProvider());
    registry.register(new MovyProvider());
    registry.register(new BoomflixProvider());
    registry.register(new VidriftProvider());
    registry.register(new VixSrcProvider());

    if (env.ENABLE_CINEZO === 'true') {
        registry.register(new CinezoProvider());
    }

    if (env.ENABLE_VAPLAYER === 'true') {
        registry.register(new VaplayerProvider());
    }
}

function prioritizeProviders(payload: string): string {
    try {
        const body = JSON.parse(payload) as { sources?: Array<{ provider?: { id?: string } }> };
        if (Array.isArray(body.sources)) {
            body.sources.sort((a, b) => {
                const rank = (source: { provider?: { id?: string } }) => {
                    const id = source.provider?.id?.toLowerCase();
                    const index = id ? providerPriority.indexOf(id) : -1;
                    return index === -1 ? providerPriority.length : index;
                };
                return rank(a) - rank(b);
            });
        }
        return JSON.stringify(body);
    } catch {
        return payload;
    }
}
async function main() {
    // Direct delivery is the low-cost default: the player downloads eligible
    // sources from their upstream host instead of relaying video through us.
    // Set MEDIA_PROXY=true only when a source needs server-side headers or
    // manifest rewriting to play.
    const mediaProxyEnabled = process.env.MEDIA_PROXY === 'true';

    const server = new OMSSServer({
        name: 'CinePro',
        version: '1.0.0',

        // Network
        host: process.env.HOST ?? 'localhost',
        port: Number(process.env.PORT ?? 3000),
        publicUrl: process.env.PUBLIC_URL,

        // Cache (memory for dev, Redis for prod)
        cache: {
            type: (process.env.CACHE_TYPE as 'memory' | 'redis') ?? 'memory',
            ttl: {
                sources: 60 * 60,
                subtitles: 60 * 60 * 24
            },
            redis: {
                host: process.env.REDIS_HOST ?? 'localhost',
                port: Number(process.env.REDIS_PORT ?? 6379),
                password: process.env.REDIS_PASSWORD
            }
        },

        // TMDB
        tmdb: {
            apiKey: process.env.TMDB_API_KEY!,
            cacheTTL: 24 * 60 * 60 // 24h
        },

        // Third Party Proxy removal
        proxyConfig: {
            knownThirdPartyProxies: knownThirdPartyProxies,
            streamPatterns
        },

        cors: {
            origin: process.env.CORS_ORIGIN ?? '*',
            methods: ['GET', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            exposedHeaders: ['Content-Range', 'Accept-Ranges', 'ETag'],
            preflightContinue: false,
            optionsSuccessStatus: 204
        },

        stremio: {
            // exposes a stremio addon on /stremio/manifest.json
            enableNativeAddon: process.env.STREMIO_ADDON === 'true',
            // you can your own custom stremio addons as sources into cinepro.
            stremioAddons: []
            /*
            stremioAddons: [
                {
                    id: 'some-unique-id',
                    url: 'https://example.com/manifest.json',
                    enabled: true
                }
            ]
            */
        },

        // MCP for AI agents
        mcp: {
            enabled: process.env.MCP_ENABLED === 'true'
        }
    });

    if (mediaProxyEnabled) {
        registerVidLinkProxy(server.getInstance());
        registerCinezoProxy(server.getInstance());
    }

    if (!mediaProxyEnabled) {
        server.getInstance().addHook('onSend', async (_request, _reply, payload) => {
            if (typeof payload === 'string') {
                return prioritizeProviders(replaceProxyUrlsInResponse(payload));
            }
            if (Buffer.isBuffer(payload)) {
                return prioritizeProviders(replaceProxyUrlsInResponse(payload.toString('utf8')));
            }
            return payload;
        });
    }
    registerProviders(server, process.env);


    await server.start();

    const publicUrl =
        process.env.PUBLIC_URL ??
        `http://${process.env.HOST ?? 'localhost'}:${process.env.PORT ?? 3000}`;

    const uiUrl = `https://ui.cinepro.cc/?omssurl=${encodeURIComponent(publicUrl)}`;

    const title = '🚀 CinePro/ui is in public testing';
    const contrib =
        '🤝 We are looking for contributors to improve and develop!';
    const repo = 'Contribute: https://github.com/cinepro-org/ui';
    const tryIt = `🌐 Try it out: ${uiUrl} !`;
    const note =
        'You will need to give the website "access to local applications" that it works.';

    const lines = [title, '', repo, '', contrib, '', tryIt, '', note];

    // compute box width based on longest line
    const width = Math.max(...lines.map((l) => l.length)) + 2;

    const borderTop = '╭' + '─'.repeat(width) + '╮';
    const borderBottom = '╰' + '─'.repeat(width) + '╯';

    const pad = (line: string) => '│ ' + line.padEnd(width - 2, ' ') + ' │';

    console.log(`
================== CINEPRO BETA ANNOUNCEMENT ==================

${borderTop}
${lines.map(pad).join('\n')}
${borderBottom}
`);
}

const isCloudflareWorker =
    process.env.CLOUDFLARE_WORKERS === 'true' ||
    (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') ||
    typeof (globalThis as any).WebSocketPair !== 'undefined';

if (!isCloudflareWorker) {
    main().catch(() => {
        process.exit(1);
    });
}

async function withoutStartupTimers<T>(factory: () => Promise<T>): Promise<T> {
    const originalSetInterval = globalThis.setInterval;
    try {
        globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
        return await factory();
    } finally {
        globalThis.setInterval = originalSetInterval;
    }
}

async function createWorkerServer(env: Record<string, string | undefined>) {
    if (typeof process !== 'undefined') Object.assign(process.env, env);

    const server = new OMSSServer({
        name: 'CinePro',
        version: '1.0.0',
        host: env.HOST ?? 'localhost',
        port: Number(env.PORT ?? 3000),
        publicUrl: env.PUBLIC_URL,
        cache: {
            type: (env.CACHE_TYPE as 'memory' | 'redis') ?? 'memory',
            ttl: { sources: 60 * 60, subtitles: 60 * 60 * 24 },
            redis: {
                host: env.REDIS_HOST ?? 'localhost',
                port: Number(env.REDIS_PORT ?? 6379),
                password: env.REDIS_PASSWORD
            }
        },
        tmdb: { apiKey: env.TMDB_API_KEY!, cacheTTL: 24 * 60 * 60 },
        proxyConfig: { knownThirdPartyProxies, streamPatterns },
        cors: {
            origin: env.CORS_ORIGIN ?? '*',
            methods: ['GET', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            exposedHeaders: ['Content-Range', 'Accept-Ranges', 'ETag'],
            preflightContinue: false,
            optionsSuccessStatus: 204
        },
        stremio: { enableNativeAddon: env.STREMIO_ADDON === 'true', stremioAddons: [] },
        mcp: { enabled: env.MCP_ENABLED === 'true' }
    });

    if (env.MEDIA_PROXY === 'true') {
        registerVidLinkProxy(server.getInstance());
        registerCinezoProxy(server.getInstance());
    } else {
        server.getInstance().addHook('onSend', async (_request: any, _reply: any, payload: any) => {
            if (typeof payload === 'string') return prioritizeProviders(replaceProxyUrlsInResponse(payload));
            if (Buffer.isBuffer(payload)) return prioritizeProviders(replaceProxyUrlsInResponse(payload.toString('utf8')));
            return payload;
        });
    }

    registerProviders(server, env);

    const app = server.getInstance();
    await app.ready();
    return app;
}

const workerServerPromise = isCloudflareWorker
    ? withoutStartupTimers(() => createWorkerServer(process.env as Record<string, string | undefined>))
    : undefined;

export default {
    async fetch(request: Request, env: any, ctx: any) {
        const workerServer: any = await (workerServerPromise ?? createWorkerServer(env));
        const url = new URL(request.url);
        const headers: any = {};
        for (const [key, value] of request.headers.entries()) {
            headers[key] = value;
        }
        
        const res = await workerServer.inject({
            method: request.method,
            url: url.pathname + url.search,
            headers,
            payload: request.body ? await request.arrayBuffer() : undefined,
        });

        return new Response(res.rawPayload, {
            status: res.statusCode,
            headers: res.headers
        });
    }
};
