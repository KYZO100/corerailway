import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';
import { decryptResponse } from './decryptor.js';
import type { VideasyServer } from './videasy.types.js';

const VIDEASY_API = 'https://api.speedracelight.com';

const VIDEASY_SERVERS: readonly VideasyServer[] = [
    { name: 'CDN', url: `${VIDEASY_API}/cdn/sources-with-title` },
    { name: 'LaMovie', url: `${VIDEASY_API}/lamovie/sources-with-title` },
    {
        name: 'Meine',
        url: `${VIDEASY_API}/meine/sources-with-title`,
        moviesOnly: true
    }
] as const;

export class VideasyProvider extends BaseProvider {
    readonly id = 'Videasy';
    readonly name = 'Videasy';
    readonly enabled = true;
    readonly BASE_URL = VIDEASY_API;
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://player.videasy.net',
        Referer: 'https://player.videasy.net/'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    private async getSources(
        media: ProviderMediaObject
    ): Promise<ProviderResult> {
        const seed = await this.fetchSeed(media.tmdbId);
        if (!seed) return this.emptyResult('unable to fetch decryption seed');

        const aggregate = {
            sources: [] as ProviderResult['sources'],
            subtitles: [] as ProviderResult['subtitles'],
            failedServers: 0
        };
        const seenUrls = new Set<string>();

        await this.queryServers(media, seed, seenUrls, aggregate);

        // Seeds are short-lived. Retry once with a new seed when the initial
        // response set was stale or did not contain a matching source.
        if (aggregate.sources.length === 0) {
            const freshSeed = await this.fetchSeed(media.tmdbId);
            if (freshSeed && freshSeed !== seed) {
                aggregate.failedServers = 0;
                await this.queryServers(media, freshSeed, seenUrls, aggregate);
            }
        }

        if (aggregate.sources.length === 0) {
            return this.emptyResult('all videasy servers returned no sources');
        }

        const diagnostics: ProviderResult['diagnostics'] = [];
        if (aggregate.failedServers > 0) {
            diagnostics.push({
                code: 'PARTIAL_SCRAPE',
                message: `${aggregate.failedServers} of ${this.availableServers(media).length} Videasy servers did not return results`,
                field: '',
                severity: 'warning'
            });
        }

        return {
            sources: aggregate.sources,
            subtitles: aggregate.subtitles,
            diagnostics
        };
    }

    private async fetchSeed(mediaId: string): Promise<string | null> {
        try {
            const url = new URL(`${VIDEASY_API}/seed`);
            url.searchParams.set('mediaId', mediaId);
            const response = await fetch(url, { headers: this.HEADERS });
            if (!response.ok) return null;

            const body = (await response.json()) as { seed?: unknown };
            return typeof body.seed === 'string' && body.seed
                ? body.seed
                : null;
        } catch {
            return null;
        }
    }

    private async queryServers(
        media: ProviderMediaObject,
        seed: string,
        seenUrls: Set<string>,
        aggregate: {
            sources: ProviderResult['sources'];
            subtitles: ProviderResult['subtitles'];
            failedServers: number;
        }
    ): Promise<void> {
        const results = await Promise.allSettled(
            this.availableServers(media).map((server) =>
                this.fetchFromServer(server, media, seed)
            )
        );

        for (const result of results) {
            if (result.status === 'rejected' || result.value === null) {
                aggregate.failedServers++;
                continue;
            }

            for (const source of result.value.sources) {
                if (seenUrls.has(source.url)) continue;
                seenUrls.add(source.url);
                aggregate.sources.push(source);
            }
            aggregate.subtitles.push(...result.value.subtitles);
        }
    }

    private availableServers(
        media: ProviderMediaObject
    ): readonly VideasyServer[] {
        return VIDEASY_SERVERS.filter(
            (server) => !(server.moviesOnly && media.type === 'tv')
        );
    }

    private async fetchFromServer(
        server: VideasyServer,
        media: ProviderMediaObject,
        seed: string
    ): Promise<ProviderResult | null> {
        const url = new URL(server.url);
        url.searchParams.set('title', media.title ?? '');
        url.searchParams.set(
            'mediaType',
            media.type === 'tv' ? 'TV Series' : 'Movie'
        );
        url.searchParams.set('year', String(media.releaseYear ?? ''));
        url.searchParams.set('tmdbId', media.tmdbId);
        url.searchParams.set('imdbId', media.imdbId ?? '');
        url.searchParams.set('enc', '2');
        url.searchParams.set('seed', seed);

        if (media.type === 'tv') {
            url.searchParams.set('seasonId', String(media.s ?? 1));
            url.searchParams.set('episodeId', String(media.e ?? 1));
        }

        try {
            const response = await fetch(url, { headers: this.HEADERS });
            if (!response.ok) return null;

            const encryptedPayload = await response.text();
            if (
                encryptedPayload.length < 20 ||
                encryptedPayload.trimStart().startsWith('<')
            ) {
                return null;
            }

            const payload = decryptResponse(
                encryptedPayload,
                seed,
                media.tmdbId
            );
            if (!payload || !Array.isArray(payload.sources)) return null;

            const subtitles = Array.isArray(payload.subtitles)
                ? payload.subtitles
                : [];

            return {
                sources: payload.sources
                    .filter((source) => Boolean(source?.url))
                    .map((source) => ({
                        url: this.createProxyUrl(source.url, this.HEADERS),
                        type: this.detectType(source.url, source.type),
                        quality: this.normalizeQuality(source.quality),
                        audioTracks: [{ language: 'en', label: 'English' }],
                        provider: {
                            id: this.id,
                            name: `${this.name} ${server.name}`
                        }
                    })),
                subtitles: subtitles
                    .filter((subtitle) => Boolean(subtitle?.url))
                    .map((subtitle) => ({
                        url: this.createProxyUrl(subtitle.url, {}),
                        label:
                            subtitle.label ??
                            subtitle.lang ??
                            subtitle.language ??
                            'Unknown',
                        format: this.detectSubtitleFormat(subtitle.url)
                    })),
                diagnostics: []
            };
        } catch {
            return null;
        }
    }

    private detectType(url: string, hint?: string): 'hls' | 'mp4' {
        const normalizedHint = hint?.toLowerCase() ?? '';
        return normalizedHint.includes('hls') ||
            normalizedHint.includes('m3u8') ||
            url.toLowerCase().includes('.m3u8')
            ? 'hls'
            : 'mp4';
    }

    private normalizeQuality(raw?: string): string {
        const value = raw?.trim();
        return value && /^\d{3,4}p$|^4K$|^8K$|^HD$|^SD$/i.test(value)
            ? value
            : 'unknown';
    }

    private detectSubtitleFormat(
        url: string
    ): 'vtt' | 'srt' | 'ass' | 'ssa' | 'ttml' {
        const extension = url.split(/[?#]/)[0].split('.').pop()?.toLowerCase();
        return extension === 'ass' ||
            extension === 'ssa' ||
            extension === 'ttml'
            ? extension
            : extension === 'vtt'
              ? 'vtt'
              : 'srt';
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
            const response = await fetch(this.BASE_URL, {
                method: 'HEAD',
                headers: this.HEADERS
            });
            return response.status < 500;
        } catch {
            return false;
        }
    }
}

