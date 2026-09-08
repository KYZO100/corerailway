import { BaseProvider } from '@omss/framework';
import type { ProviderCapabilities, ProviderMediaObject, ProviderResult, Source } from '@omss/framework';

const API_URL = 'https://streamdata.vaplayer.ru/api.php';
const SITE_URL = 'https://vaplayer.ru';
const TIMEOUT_MS = 25_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

type VaplayerPayload = {
    status_code?: string;
    data?: { stream_urls?: unknown; title?: unknown; imdb_id?: unknown };
};

export class VaplayerProvider extends BaseProvider {
    readonly id = 'vaplayer';
    readonly name = 'Vaplayer';
    readonly enabled = true;
    readonly BASE_URL = SITE_URL;
    readonly HEADERS = {
        Accept: 'application/json, text/plain, */*',
        Origin: SITE_URL,
        Referer: 'https://nextgencloudfabric.com/',
        'User-Agent': USER_AGENT
    };
    readonly capabilities: ProviderCapabilities = { supportedContentTypes: ['movies', 'tv'] };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        if (media.s == null || media.e == null) return this.empty('missing season or episode number');
        return this.getSources(media);
    }

    private async getSources(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            const url = new URL(API_URL);
            url.searchParams.set('tmdb', media.tmdbId);
            url.searchParams.set('type', media.type === 'tv' ? 'tv' : 'movie');
            if (media.type === 'tv') {
                url.searchParams.set('season', String(media.s));
                url.searchParams.set('episode', String(media.e));
            }
            const response = await fetch(url, { headers: this.HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!response.ok) return this.empty(`source request returned ${response.status}`);
            const payload = await response.json() as VaplayerPayload;
            const urls = Array.isArray(payload.data?.stream_urls) ? payload.data.stream_urls : [];
            const seen = new Set<string>();
            const sources: Source[] = [];
            for (const raw of urls) {
                if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw) || seen.has(raw)) continue;
                seen.add(raw);
                sources.push({
                    url: this.createProxyUrl(raw, this.streamHeaders(raw)),
                    type: 'hls',
                    quality: this.quality(raw),
                    audioTracks: [{ language: 'und', label: 'Original' }],
                    provider: { id: this.id, name: this.name }
                });
            }
            return sources.length ? { sources, subtitles: [], diagnostics: [] } : this.empty('no HLS streams returned');
        } catch (error) {
            return this.empty(error instanceof Error ? error.message : 'source request failed');
        }
    }

    private streamHeaders(url: string): Record<string, string> {
        return { Accept: '*/*', Referer: 'https://nextgencloudfabric.com/', 'User-Agent': USER_AGENT };
    }

    private quality(url: string): string {
        const match = url.match(/(?:^|[^0-9])([0-9]{3,4})p(?:[^0-9]|$)/i);
        return match ? `${match[1]}p` : 'Auto';
    }

    private empty(message: string): ProviderResult {
        return { sources: [], subtitles: [], diagnostics: [{ code: 'PROVIDER_ERROR', message: `${this.name}: ${message}`, field: '', severity: 'error' }] };
    }

    async healthCheck(): Promise<boolean> {
        try {
            const response = await fetch(API_URL, { method: 'HEAD', headers: this.HEADERS, signal: AbortSignal.timeout(10_000) });
            return response.status < 500;
        } catch { return false; }
    }
}