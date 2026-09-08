import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle,
    SubtitleFormat
} from '@omss/framework';

const SITE_URL = 'https://cinezo.live';
const PLAYER_URL = 'https://player.cinezo.live';
const API_URL = 'https://proxy1.flikhub.net';
const TV_API_URL = 'https://proxy3.flikhub.net';
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

type CinezoQuality = {
    quality?: unknown;
    url?: unknown;
    type?: unknown;
};

type CinezoSource = {
    source?: unknown;
    label?: unknown;
    url?: unknown;
    type?: unknown;
    qualities?: unknown;
};

type CinezoSubtitle = {
    label?: unknown;
    file?: unknown;
    type?: unknown;
};

type CinezoResponse = {
    source?: CinezoSource | null;
    subtitles?: unknown;
};

function qualityHeight(value: unknown): number | null {
    const match = String(value ?? '').match(/(?:^|[^0-9])(\d{3,4})p(?:[^0-9]|$)/i);
    const height = match ? Number(match[1]) : Number(String(value ?? '').match(/\b(\d{3,4})\b/)?.[1]);
    return Number.isFinite(height) && height > 0 ? height : null;
}

export class CinezoProvider extends BaseProvider {
    readonly id = 'cinezo';
    readonly name = 'Cinezo';
    readonly enabled = true;
    readonly BASE_URL = SITE_URL;
    readonly HEADERS = {
        Accept: 'application/json, text/plain, */*',
        Origin: PLAYER_URL,
        Referer: `${PLAYER_URL}/`,
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
            return this.emptyResult('missing season or episode number');
        }
        return this.getSources(media);
    }

    private async getSources(
        media: ProviderMediaObject
    ): Promise<ProviderResult> {
        try {
            const isTV = media.type === 'tv';
            const url = new URL(
                isTV ? '/tv' : '/movie',
                isTV ? TV_API_URL : API_URL
            );
            url.searchParams.set('id', media.tmdbId);
            if (media.type === 'tv') {
                url.searchParams.set('season', String(media.s));
                url.searchParams.set('episode', String(media.e));
            }
            url.searchParams.set('mode', 'json');
            // Cinezo currently exposes Berlin, Zendaya and CineFreak. Berlin is
            // the only server verified for both movies and TV and returns HLS.
            url.searchParams.set('sources', isTV ? 'zendaya' : 'berlin');
            url.searchParams.set('hevc', '1');

            let payload: CinezoResponse | null = null;
            let sources: Source[] = [];
            // Berlin occasionally answers with `source: null` while several
            // providers are being resolved at once. Retry once with a cache
            // buster instead of making Cinezo disappear from the response.
            for (
                let attempt = 0;
                attempt < 2 && sources.length === 0;
                attempt++
            ) {
                const requestUrl = new URL(url);
                if (attempt > 0) {
                    requestUrl.searchParams.set('_', String(Date.now()));
                }
                payload = await this.fetchJson<CinezoResponse>(requestUrl);
                sources = isTV
                    ? this.mapDashSource(payload.source)
                    : this.mapSources(payload.source);
            }

            if (sources.length === 0) {
                return this.emptyResult(
                    isTV
                        ? 'Zendaya returned no playable DASH stream'
                        : 'Berlin returned no playable HLS stream'
                );
            }

            return {
                sources,
                subtitles: this.mapSubtitles(payload?.subtitles),
                diagnostics: []
            };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'unknown provider error'
            );
        }
    }

    private mapSources(value?: CinezoSource | null): Source[] {
        if (!value) return [];
        const candidates: CinezoQuality[] =
            Array.isArray(value.qualities) && value.qualities.length > 0
                ? (value.qualities as CinezoQuality[])
                : [
                      {
                          quality: '1080p',
                          url: value.url,
                          type: value.type
                      }
                  ];

        const seen = new Set<string>();
        const sources: Source[] = [];
        for (const candidate of candidates) {
            const relayUrl = this.safeHttpUrl(candidate.url);
            if (!relayUrl) continue;
            const resolved = this.unwrapBerlinRelay(relayUrl);
            if (!resolved || seen.has(resolved.url.toString())) continue;
            // Cinezo labels this response as mp4, but its /api?url= endpoint
            // returns an HLS master playlist. Treating it as mp4 causes buffering.
            if (!this.isHlsUrl(resolved.url, candidate.type)) continue;
            seen.add(resolved.url.toString());
            sources.push({
                url: this.createProxyUrl(
                    resolved.url.toString(),
                    resolved.headers
                ),
                type: 'hls',
                quality: this.stringValue(candidate.quality) || 'Auto',
                audioTracks: [{ language: 'und', label: 'Original' }],
                provider: { id: this.id, name: this.name }
            });
        }
        return sources;
    }

    private mapDashSource(value?: CinezoSource | null): Source[] {
        if (!value) return [];
        const url = this.safeHttpUrl(value.url);
        if (
            !url ||
            url.hostname !== 'proxy3.flikhub.net' ||
            !url.pathname.endsWith('.mpd')
        ) {
            return [];
        }

        const proxyUrl = new URL(
            this.createProxyUrl(SITE_URL, {
                ...this.HEADERS,
                'X-Cinezo-Target': url.toString()
            })
        );
        proxyUrl.pathname = '/v1/cinezo-proxy';
        return [
            {
                url: proxyUrl.toString(),
                type: 'dash',
                quality: '1080p',
                audioTracks: [{ language: 'und', label: 'Original' }],
                provider: { id: this.id, name: this.name }
            }
        ];
    }

    private unwrapBerlinRelay(
        relayUrl: URL
    ): { url: URL; headers: Record<string, string> } | null {
        if (
            relayUrl.hostname !== 'proxy1.flikhub.net' ||
            relayUrl.pathname !== '/api'
        ) {
            return { url: relayUrl, headers: this.HEADERS };
        }
        const target = this.safeHttpUrl(relayUrl.searchParams.get('url'));
        if (!target) return null;
        const rawHeaders = relayUrl.searchParams.get('proxyHeaders');
        let headers: Record<string, string> = {};
        if (rawHeaders) {
            try {
                headers = this.safeHeaders(JSON.parse(rawHeaders));
            } catch {
                headers = {};
            }
        }
        return {
            url: target,
            headers: { ...headers, Accept: '*/*' }
        };
    }

    private mapSubtitles(value: unknown): Subtitle[] {
        if (!Array.isArray(value)) return [];
        const seen = new Set<string>();
        return value.flatMap((raw, index) => {
            if (!raw || typeof raw !== 'object') return [];
            const subtitle = raw as CinezoSubtitle;
            const url = this.safeHttpUrl(subtitle.file);
            if (!url || seen.has(url.toString())) return [];
            seen.add(url.toString());
            return [
                {
                    url: this.createProxyUrl(url.toString(), {
                        Referer: `${PLAYER_URL}/`,
                        'User-Agent': USER_AGENT
                    }),
                    label:
                        this.stringValue(subtitle.label) ||
                        `Subtitle ${index + 1}`,
                    format: this.subtitleFormat(
                        this.stringValue(subtitle.type) || url.pathname
                    )
                }
            ];
        });
    }

    private isHlsUrl(url: URL, type: unknown): boolean {
        return (
            this.stringValue(type).toLowerCase() === 'hls' ||
            url.pathname.endsWith('.m3u8') ||
            (url.hostname === 'proxy1.flikhub.net' &&
                url.pathname === '/api' &&
                url.searchParams.has('url'))
        );
    }

    private async fetchJson<T>(url: URL): Promise<T> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const response = await fetch(url, {
                    headers: this.HEADERS,
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                });
                if (!response.ok) {
                    if (response.status >= 500 && attempt === 0) {
                        await response.body?.cancel();
                        continue;
                    }
                    throw new Error(`source request returned ${response.status}`);
                }
                const text = await response.text();
                if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
                    throw new Error('source response is too large');
                }
                try {
                    return JSON.parse(text) as T;
                } catch {
                    throw new Error('source request returned invalid JSON');
                }
            } catch (error) {
                lastError = error;
                if (attempt === 0) continue;
            }
        }
        throw lastError instanceof Error
            ? lastError
            : new Error('source request failed');
    }

    private safeHttpUrl(value: unknown): URL | null {
        if (typeof value !== 'string' || !value.trim()) return null;
        try {
            const url = new URL(value);
            return url.protocol === 'https:' || url.protocol === 'http:'
                ? url
                : null;
        } catch {
            return null;
        }
    }

    private safeHeaders(value: unknown): Record<string, string> {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {};
        }
        const headers: Record<string, string> = {};
        for (const [name, rawValue] of Object.entries(value)) {
            if (
                typeof rawValue === 'string' &&
                !/[\0\r\n]/.test(name + rawValue)
            ) {
                headers[name] = rawValue;
            }
        }
        return headers;
    }

    private subtitleFormat(value: string): SubtitleFormat {
        const normalized = value.toLowerCase();
        if (normalized.includes('ass')) return 'ass';
        if (normalized.includes('ssa')) return 'ssa';
        if (normalized.includes('ttml')) return 'ttml';
        if (normalized.includes('srt')) return 'srt';
        return 'vtt';
    }

    private stringValue(value: unknown): string {
        return typeof value === 'string' ? value.trim() : '';
    }

    private emptyResult(message: string): ProviderResult {
        return {
            sources: [],
            subtitles: [],
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

    async healthCheck(): Promise<boolean> {
        try {
            const response = await fetch(SITE_URL, {
                method: 'HEAD',
                headers: { 'User-Agent': USER_AGENT },
                signal: AbortSignal.timeout(10_000)
            });
            return response.status < 500;
        } catch {
            return false;
        }
    }
}
