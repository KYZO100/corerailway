import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    SourceType,
    Subtitle,
    SubtitleFormat
} from '@omss/framework';

const API_BASE = 'https://api.shows.st';
const PLAYER_BASE = 'https://player.vidlove.cc';

const SERVERS = [
    { name: 'Barbarian King', key: 'moviebox' },
    { name: 'Barbarian King 2.0', key: 'moviebox2' },
    { name: 'Archer Queen', key: 'vidapi' },
    { name: 'Royal Champion', key: 'ipcloud' },
    { name: 'Ice Wizard', key: 'tcloud' },
    { name: 'Wizard', key: 'vixsrc' },
    { name: 'Hog Rider', key: '1embed' },
    { name: 'Golem', key: 'xpass' },
    { name: 'Balloon', key: 'vidrift' },
    { name: 'Healer', key: 'lookmovie' },
    { name: 'Miner', key: 'vidnest' }
] as const;

type Server = (typeof SERVERS)[number];

type Quality = {
    url?: string;
    quality?: string | number;
    type?: string;
};

type SubtitlePayload = {
    file?: string;
    url?: string;
    label?: string;
    display?: string;
    language?: string;
    format?: string;
    type?: string;
};

type ApiPayload = {
    source?: {
        url?: string;
        type?: string;
        manifest?: string;
        qualities?: Quality[];
    };
    subtitles?: SubtitlePayload[];
};

export class Movies67Provider extends BaseProvider {
    readonly id = '67movies';
    readonly name = '67Movies';
    readonly enabled = true;
    readonly BASE_URL = API_BASE;
    readonly HEADERS = {
        Accept: 'application/json',
        Origin: PLAYER_BASE,
        Referer: `${PLAYER_BASE}/`,
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        if (!media.s || !media.e) {
            return this.emptyResult('missing season or episode number');
        }

        return this.getSources(media);
    }

    private async getSources(
        media: ProviderMediaObject
    ): Promise<ProviderResult> {
        // Vidapi is the current reliable 67Movies backend. Resolving it first
        // avoids sending eleven requests alongside the rest of the core's
        // providers; the remaining backends remain a fallback when it is empty.
        const primaryServers = SERVERS.filter((server) => server.key === 'vidapi');
        let results = await Promise.allSettled(
            primaryServers.map((server) => this.fetchServer(media, server))
        );

        const primaryReturnedSources = results.some(
            (result) =>
                result.status === 'fulfilled' &&
                result.value !== null &&
                this.sourceEntries(result.value.payload).length > 0
        );

        if (!primaryReturnedSources) {
            results = await Promise.allSettled(
                SERVERS.filter((server) => server.key !== 'vidapi').map((server) =>
                    this.fetchServer(media, server)
                )
            );
        }
        const sources: Source[] = [];
        const subtitles = new Map<string, Subtitle>();
        const seenUrls = new Set<string>();
        let failedServers = 0;
        let collectedSubtitles = false;

        for (const result of results) {
            if (result.status !== 'fulfilled' || result.value === null) {
                failedServers++;
                continue;
            }

            const { server, payload } = result.value;
            if (!collectedSubtitles && Array.isArray(payload.subtitles)) {
                this.collectSubtitles(payload.subtitles, subtitles);
                collectedSubtitles = true;
            }

            for (const entry of this.sourceEntries(payload)) {
                if (seenUrls.has(entry.url)) continue;
                seenUrls.add(entry.url);

                sources.push({
                    url: this.createProxyUrl(entry.url, this.HEADERS),
                    type: this.inferSourceType(entry.url, entry.type),
                    quality: this.normalizeQuality(entry.quality),
                    audioTracks: [{ language: 'eng', label: 'English' }],
                    provider: {
                        id: this.id,
                        name: `${this.name} ${server.name}`
                    }
                });
            }
        }

        if (sources.length === 0) {
            return this.emptyResult('all 67Movies servers returned no sources');
        }

        return {
            sources,
            subtitles: [...subtitles.values()],
            diagnostics:
                failedServers > 0
                    ? [
                          {
                              code: 'PARTIAL_SCRAPE',
                              message: `${failedServers} of ${SERVERS.length} 67Movies servers did not return results`,
                              field: '',
                              severity: 'warning'
                          }
                      ]
                    : []
        };
    }

    private async fetchServer(
        media: ProviderMediaObject,
        server: Server
    ): Promise<{ server: Server; payload: ApiPayload } | null> {
        const url = new URL(`${API_BASE}/${media.type}`);
        url.searchParams.set('id', media.tmdbId);
        url.searchParams.set('mode', 'json');
        url.searchParams.set('sources', server.key);

        if (media.type === 'tv') {
            url.searchParams.set('season', String(media.s));
            url.searchParams.set('episode', String(media.e));
        }

        try {
            const response = await fetch(url, {
                headers: this.HEADERS,
                signal: AbortSignal.timeout(15_000)
            });
            if (!response.ok) return null;

            return {
                server,
                payload: (await response.json()) as ApiPayload
            };
        } catch {
            return null;
        }
    }

    private sourceEntries(
        payload: ApiPayload
    ): Array<{ url: string; quality: string | number; type?: string }> {
        const source = payload.source;
        if (!source || typeof source !== 'object') return [];

        const entries: Array<{
            url: string;
            quality: string | number;
            type?: string;
        }> = [];
        if (typeof source.url === 'string' && source.url) {
            entries.push({
                url: source.url,
                quality: 'Auto',
                type: source.type ?? this.typeFromManifest(source.manifest)
            });
        }

        for (const quality of source.qualities ?? []) {
            if (typeof quality?.url === 'string' && quality.url) {
                entries.push({
                    url: quality.url,
                    quality: quality.quality ?? 'Auto',
                    type: quality.type
                });
            }
        }

        return entries;
    }

    private collectSubtitles(
        items: SubtitlePayload[] | undefined,
        subtitles: Map<string, Subtitle>
    ): void {
        for (const item of items ?? []) {
            const url = item.file ?? item.url;
            if (!url || subtitles.has(url)) continue;

            subtitles.set(url, {
                url: this.createProxyUrl(url, this.HEADERS),
                label: item.label ?? item.display ?? item.language ?? 'Unknown',
                format: this.inferSubtitleFormat(item.format ?? item.type ?? url)
            });
        }
    }

    private typeFromManifest(manifest: string | undefined): string | undefined {
        return manifest?.trimStart().startsWith('#EXTM3U') ? 'hls' : undefined;
    }
    private inferSourceType(url: string, hint?: string): SourceType {
        const value = `${hint ?? ''} ${url}`.toLowerCase();
        if (value.includes('m3u8') || value.includes('hls')) return 'hls';
        if (value.includes('mpd') || value.includes('dash')) return 'dash';
        if (value.includes('webm')) return 'webm';
        if (value.includes('mkv')) return 'mkv';
        return 'mp4';
    }

    private inferSubtitleFormat(value: string): SubtitleFormat {
        const normalized = value.toLowerCase();
        if (normalized.includes('ass')) return 'ass';
        if (normalized.includes('ssa')) return 'ssa';
        if (normalized.includes('ttml')) return 'ttml';
        if (normalized.includes('srt')) return 'srt';
        return 'vtt';
    }

    private normalizeQuality(value: string | number): string {
        const quality = String(value).trim();
        return !quality || quality.toLowerCase() === 'auto'
            ? 'Auto'
            : /^\d+$/.test(quality)
              ? `${quality}p`
              : quality;
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
                headers: this.HEADERS,
                signal: AbortSignal.timeout(10_000)
            });
            return response.status < 500;
        } catch {
            return false;
        }
    }
}

