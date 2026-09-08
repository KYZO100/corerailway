import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    SourceType,
    Subtitle
} from '@omss/framework';

const RIVE = 'https://www.rivestream.app';
const TIMEOUT = 12_000;
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const SERVICES = ['citadel'] as const;
const SECRET_PARTS = [
    '4Z7lUo', 'gwIVSMD', 'PLmz2elE2v', 'Z4OFV0', 'SZ6RZq6Zc',
    'zhJEFYxrz8', 'FOm7b0', 'axHS3q4KDq', 'o9zuXQ', '4Aebt',
    'wgjjWwKKx', 'rY4VIxqSN', 'kfjbnSo', '2DyrFA1M', 'YUixDM9B',
    'JQvgEj0', 'mcuFx6JIek', 'eoTKe26gL', 'qaI9EVO1rB', '0xl33btZL',
    '1fszuAU', 'a7jnHzst6P', 'wQuJkX', 'cBNhTJlEOf', 'KNcFWhDvgT',
    'XipDGjST', 'PCZJlbHoyt', '2AYnMZkqd', 'HIpJh', 'KH0C3iztrG',
    'W81hjts92', 'rJhAT', 'NON7LKoMQ', 'NMdY3nsKzI', 't4En5v',
    'Qq5cOQ9H', 'Y9nwrp', 'VX5FYVfsf', 'cE5SJG', 'x1vj1',
    'HegbLe', 'zJ3nmt4OA', 'gt7rxW57dq', 'clIE9b', 'jyJ9g',
    'B5jXjMCSx', 'cOzZBZTV', 'FTXGy', 'Dfh1q1', 'ny9jqZ2POI',
    'X2NnMn', 'MBtoyD', 'qz4Ilys7wB', '68lbOMye', '3YUJnmxp',
    '1fv5Imona', 'PlfvvXD7mA', 'ZarKfHCaPR', 'owORnX', 'dQP1YU',
    'dVdkx', 'qgiK0E', 'cx9wQ', '5F9bGa', '7UjkKrp',
    'Yvhrj', 'wYXez5Dg3', 'pG4GMU', 'MwMAu', 'rFRD5wlM'
];

interface RiveResponse {
    data?: {
        sources?: Array<{
            url?: unknown;
            source?: unknown;
            quality?: unknown;
            format?: unknown;
        }>;
    };
}

export class BoomflixProvider extends BaseProvider {
    readonly id = 'boomflix';
    readonly name = 'Boomflix';
    readonly enabled = true;
    readonly BASE_URL = 'https://boomflix.qzz.io';
    readonly HEADERS = {
        Accept: 'application/json, text/plain, */*',
        Referer: `${RIVE}/`,
        'User-Agent': USER_AGENT
    };
    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        if (media.s == null || media.e == null) {
            return this.empty('missing season or episode number');
        }
        return this.getSources(media);
    }

    private async getSources(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            const results = await Promise.allSettled(
                SERVICES.map((service) => this.fetchService(media, service))
            );
            const sources = results.flatMap((result) =>
                result.status === 'fulfilled' ? result.value : []
            );

            if (sources.length === 0) return this.empty('no direct sources found');
            return { sources, subtitles: [], diagnostics: [] };
        } catch (error) {
            return this.empty(
                error instanceof Error ? error.message : 'unknown provider error'
            );
        }
    }

    private async fetchService(
        media: ProviderMediaObject,
        service: (typeof SERVICES)[number]
    ): Promise<Source[]> {
        const isMovie = media.type === 'movie';
        const secretKey = this.secret(media.tmdbId);
        const referer = isMovie
            ? `${RIVE}/watch?type=movie&id=${encodeURIComponent(media.tmdbId)}`
            : `${RIVE}/watch?type=tv&id=${encodeURIComponent(media.tmdbId)}&season=${media.s}&episode=${media.e}`;
        const query = new URLSearchParams({
            requestID: isMovie ? 'movieVideoProvider' : 'tvVideoProvider',
            id: media.tmdbId,
            service,
            secretKey
        });
        if (service === 'citadel') {
            query.set('cb', String(Math.floor(Date.now() / 3_000_000)));
        }
        if (!isMovie) {
            query.set('season', String(media.s));
            query.set('episode', String(media.e));
        }

        const response = await fetch(`${RIVE}/api/backendfetch?${query}`, {
            headers: { ...this.HEADERS, Referer: referer },
            signal: AbortSignal.timeout(TIMEOUT)
        });
        if (!response.ok) return [];
        const payload = (await response.json()) as RiveResponse;
        const rawSources = Array.isArray(payload.data?.sources)
            ? payload.data.sources
            : [];
        const sources: Source[] = [];
        const seen = new Set<string>();
        for (const raw of rawSources) {
            const url = this.safeHttpUrl(raw.url);
            if (!url || seen.has(url.toString())) continue;
            if (this.isProxyHost(url)) continue;
            seen.add(url.toString());

            const headers = {
                'User-Agent': USER_AGENT,
                Referer: referer
            };
            sources.push({
                url: this.streamUrl(url.toString(), headers),
                type: this.sourceType(this.stringValue(raw.format) || url.toString()),
                quality: this.quality(raw.quality),
                audioTracks: [{ language: 'und', label: 'Original' }],
                provider: { id: this.id, name: this.name }
            });
        }
        return sources;
    }

    private streamUrl(url: string, headers: Record<string, string>): string {
        if (process.env.MEDIA_PROXY === 'true') return this.createProxyUrl(url, headers);
        const parsed = new URL(url);
        parsed.searchParams.set('data', encodeURIComponent(JSON.stringify({ url, headers })));
        return parsed.toString();
    }

    private safeHttpUrl(value: unknown): URL | null {
        if (typeof value !== 'string') return null;
        try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
        } catch {
            return null;
        }
    }

    private isProxyHost(url: URL): boolean {
        return url.hostname.includes('proxy.') || url.hostname.includes('valhallastream');
    }

    private sourceType(value: string): SourceType {
        const normalized = value.toLowerCase();
        if (normalized.includes('dash') || normalized.includes('.mpd')) return 'dash';
        if (normalized.includes('hls') || normalized.includes('m3u8')) return 'hls';
        return 'mp4';
    }

    private quality(value: unknown): string {
        const label = String(value ?? '').trim();
        const height = label.match(/(\d{3,4})p?/i)?.[1];
        return height ? `${height}p` : label || 'Auto';
    }

    private stringValue(value: unknown): string {
        return typeof value === 'string' ? value.trim() : '';
    }

    private empty(message: string): ProviderResult {
        return {
            sources: [],
            subtitles: [] as Subtitle[],
            diagnostics: [
                {
                    code: 'PROVIDER_ERROR',
                    message: `${this.name}: ${message}`,
                    field: '',
                    severity: 'error'
                }
            ]
        };
    }

    private secret(value: string): string {
        try {
            const input = String(value);
            let seed: string;
            let index: number;
            if (Number.isNaN(Number(input))) {
                const sum = input.split('').reduce((total, char) => total + char.charCodeAt(0), 0);
                seed = SECRET_PARTS[sum % SECRET_PARTS.length] ?? Buffer.from(input).toString('base64');
                index = Math.floor((sum % input.length) / 2);
            } else {
                const numeric = Number(input);
                seed = SECRET_PARTS[numeric % SECRET_PARTS.length] ?? Buffer.from(input).toString('base64');
                index = Math.floor((numeric % input.length) / 2);
            }
            const first = this.secretHash(input.slice(0, index) + seed + input.slice(index));
            return Buffer.from(this.secretHash2(first), 'utf8').toString('base64');
        } catch {
            return 'topSecret';
        }
    }

    private secretHash(value: string): string {
        let hash = 0;
        for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            const mixed = (((hash = (code + (hash << 6) + (hash << 16) - hash) >>> 0) << (index % 5)) | (hash >>> (32 - (index % 5)))) >>> 0;
            hash ^= (mixed ^ ((code << (index % 7)) | (code >>> (8 - (index % 7))))) >>> 0;
            hash = (hash + ((hash >>> 11) ^ (hash << 3))) >>> 0;
        }
        hash ^= hash >>> 15;
        hash = (Math.imul(49842, hash & 65535) + ((Math.imul(49842, hash >>> 16) & 65535) << 16)) >>> 0;
        hash ^= hash >>> 13;
        hash = (Math.imul(40503, hash & 65535) + ((Math.imul(40503, hash >>> 16) & 65535) << 16)) >>> 0;
        return (hash ^ (hash >>> 16)).toString(16).padStart(8, '0');
    }

    private secretHash2(value: string): string {
        let hash = (0xdeadbeef ^ value.length) >>> 0;
        for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            hash = (((hash << 7) | (hash >>> 25)) >>> 0) ^ (code ^ (255 & (131 * index + 89 ^ (code << (index % 5)))));
            hash = (Math.imul(60205, hash & 65535) + (Math.imul(60205, hash >>> 16) << 16)) >>> 0;
            hash ^= hash >>> 11;
        }
        hash ^= hash >>> 15;
        hash = (Math.imul(49842, hash & 65535) + (Math.imul(49842, hash >>> 16) << 16)) >>> 0;
        hash ^= hash >>> 13;
        hash = (Math.imul(40503, hash & 65535) + (Math.imul(40503, hash >>> 16) << 16)) >>> 0;
        hash ^= hash >>> 16;
        hash = (Math.imul(10196, hash & 65535) + (Math.imul(10196, hash >>> 16) << 16)) >>> 0;
        return (hash ^ (hash >>> 15)).toString(16).padStart(8, '0');
    }
}


