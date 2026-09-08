import { BaseProvider, type SourceType } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source
} from '@omss/framework';
import type { PlaintextStreamResponse } from './vidzee.types.js';

export class VidZeeProvider extends BaseProvider {
    readonly id = 'vidzee';
    readonly name = 'VidZee';
    readonly enabled = true;
    readonly BASE_URL = 'https://core.vidzee.wtf';
    readonly PLAYER_URL = 'https://player.vidzee.wtf';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.7051.98 Safari/537.36',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: this.PLAYER_URL,
        Origin: this.PLAYER_URL
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    /** Current VidZee server identifiers. */
    private readonly SERVER_IDS = ['dcloud', 'tik', 'ipcloud', 'v6:Hindi'] as const;

    /**
     * Fetch movie sources
     */
    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media, { type: 'movie' });
    }

    /**
     * Fetch TV episode sources
     */
    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media, {
            type: 'tv',
            season: media.s?.toString(),
            episode: media.e?.toString()
        });
    }

    /**
     * VidZee now exposes a plaintext response when `e=0` is requested.
     * The former player API and decryption-key flow are no longer current.
     */
    private async getSources(
        media: ProviderMediaObject,
        params: { type: 'movie' | 'tv'; season?: string; episode?: string }
    ): Promise<ProviderResult> {
        try {
            const results = await Promise.allSettled(
                this.SERVER_IDS.map((server) =>
                    this.fetchServer(media.tmdbId, server, params)
                )
            );
            const sources: Source[] = [];
            const seenUrls = new Set<string>();
            let failedServers = 0;

            for (const result of results) {
                if (result.status !== 'fulfilled' || !result.value) {
                    failedServers++;
                    continue;
                }

                const { response, server } = result.value;
                if (seenUrls.has(response.url)) continue;
                seenUrls.add(response.url);

                const language = response.language?.toLowerCase() ?? '';
                sources.push({
                    url: this.createProxyUrl(response.url, {
                        ...this.HEADERS,
                        ...response.headers,
                        Referer: `${this.PLAYER_URL}/`
                    }),
                    type: this.inferSourceType(response.url),
                    quality: this.qualityFromUrl(response.url),
                    audioTracks: [
                        language.includes('hindi')
                            ? { language: 'hin', label: 'Hindi' }
                            : { language: 'eng', label: 'English' }
                    ],
                    provider: {
                        id: this.id,
                        name: this.name
                    }
                });
            }

            if (sources.length === 0) {
                return this.emptyResult('No working servers', media);
            }

            return {
                sources,
                subtitles: [],
                diagnostics:
                    failedServers > 0
                        ? [
                              {
                                  code: 'PARTIAL_SCRAPE',
                                  message: `${failedServers} of ${this.SERVER_IDS.length} VidZee servers did not return results`,
                                  field: '',
                                  severity: 'warning'
                              }
                          ]
                        : []
            };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'Unknown error',
                media
            );
        }
    }

    private async fetchServer(
        tmdbId: string,
        server: string,
        params: { type: 'movie' | 'tv'; season?: string; episode?: string }
    ): Promise<{ response: PlaintextStreamResponse; server: string } | null> {
        const path =
            params.type === 'movie'
                ? `/streams/movie/${tmdbId}`
                : `/streams/tv/${tmdbId}/${params.season ?? 1}/${params.episode ?? 1}`;
        const url = new URL(path, this.BASE_URL);
        url.searchParams.set('s', server);
        url.searchParams.set('e', '0');

        try {
            const response = await fetch(url, { headers: this.HEADERS });
            if (!response.ok) return null;

            const payload = (await response.json()) as PlaintextStreamResponse;
            return typeof payload?.url === 'string' && payload.url
                ? { response: payload, server }
                : null;
        } catch {
            return null;
        }
    }

    private inferSourceType(url: string): SourceType {
        return url.toLowerCase().includes('.m3u8') ? 'hls' : 'mp4';
    }

    private qualityFromUrl(url: string): string {
        return url.match(/(?:^|[^\d])(2160|1440|1080|720|480|360)p?(?:[^\d]|$)/i)?.[1]
            ? `${url.match(/(?:^|[^\d])(2160|1440|1080|720|480|360)p?(?:[^\d]|$)/i)![1]}p`
            : 'Auto';
    }
    /**
     * Return empty result with diagnostic
     */
    private emptyResult(
        message: string,
        media: ProviderMediaObject
    ): ProviderResult {
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

    /**
     * Health check
     */
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

