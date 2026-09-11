import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle
} from '@omss/framework';
import type { VixSrcApiResponse } from './vixsrc.types.js';

export class VixSrcProvider extends BaseProvider {
    readonly id = 'vixsrc';
    readonly name = 'VixSrc';
    readonly enabled = true;
    readonly BASE_URL = 'https://vixsrc.to';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        Referer: this.BASE_URL,
        Origin: this.BASE_URL
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
        try {
            const pageApiUrl = this.buildApiUrl(media);
            const apiData = await this.fetchApi(pageApiUrl);

            const embedHtml = await this.fetchEmbedPage(apiData.src);
            if (!embedHtml) {
                return this.emptyResult('failed to fetch embed page');
            }

            const tokenData = this.extractTokenData(embedHtml);
            if (!tokenData) {
                return this.emptyResult('invalid or expired token');
            }

            const masterUrl = this.buildMasterUrl(tokenData);
            const playlist = await this.fetchPlaylist(masterUrl, pageApiUrl);
            if (!playlist) {
                return this.emptyResult('failed to fetch HLS playlist');
            }

            return this.parsePlaylist(playlist, masterUrl, pageApiUrl);
        } catch (error) {
            return this.emptyResult(
                error instanceof Error
                    ? error.message
                    : 'unknown provider error'
            );
        }
    }

    private buildApiUrl(media: ProviderMediaObject): string {
        if (media.type === 'movie') {
            return `${this.BASE_URL}/api/movie/${media.tmdbId}`;
        }

        return `${this.BASE_URL}/api/tv/${media.tmdbId}/${media.s ?? 1}/${media.e ?? 1}`;
    }

    private async fetchApi(url: string): Promise<VixSrcApiResponse> {
        let failure = 'VixSrc API did not return an embed path';
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const response = await fetch(url, {
                    headers: this.HEADERS,
                    signal: AbortSignal.timeout(15_000)
                });
                if (!response.ok) {
                    failure = `VixSrc API returned ${response.status}`;
                    continue;
                }

                const payload = (await response.json()) as VixSrcApiResponse;
                if (typeof payload?.src === 'string' && payload.src) {
                    return payload;
                }
                failure = 'VixSrc API response did not include an embed path';
            } catch (error) {
                failure = `VixSrc API request failed: ${error instanceof Error ? error.message : 'unknown error'}`;
            }
        }
        throw new Error(failure);
    }

    private async fetchEmbedPage(embedPath: string): Promise<string | null> {
        try {
            const response = await fetch(new URL(embedPath, this.BASE_URL), {
                headers: {
                    ...this.HEADERS,
                    Accept: 'text/html,application/xhtml+xml,*/*'
                },
                signal: AbortSignal.timeout(15_000)
            });
            return response.ok ? await response.text() : null;
        } catch {
            return null;
        }
    }

    private extractTokenData(
        html: string
    ): { token: string; expires: string; playlist: string } | null {
        const token = html.match(/token["']\s*:\s*["']([^"']+)/)?.[1];
        const expires = html.match(/expires["']\s*:\s*["']([^"']+)/)?.[1];
        const playlist = html.match(/url\s*:\s*["']([^"']+)/)?.[1];

        if (!token || !expires || !playlist || this.isTokenExpired(expires)) {
            return null;
        }

        return { token, expires, playlist };
    }

    private isTokenExpired(expires: string): boolean {
        const expiration = Number.parseInt(expires, 10);
        return (
            !Number.isFinite(expiration) ||
            expiration * 1000 - 60_000 < Date.now()
        );
    }

    private buildMasterUrl(tokenData: {
        token: string;
        expires: string;
        playlist: string;
    }): string {
        const separator = tokenData.playlist.includes('?') ? '&' : '?';
        return `${tokenData.playlist}${separator}token=${tokenData.token}&expires=${tokenData.expires}&h=1`;
    }

    private async fetchPlaylist(
        masterUrl: string,
        pageApiUrl: string
    ): Promise<string | null> {
        try {
            const response = await fetch(masterUrl, {
                headers: { ...this.HEADERS, Referer: pageApiUrl },
                signal: AbortSignal.timeout(15_000)
            });
            return response.ok ? await response.text() : null;
        } catch {
            return null;
        }
    }

    private parsePlaylist(
        content: string,
        masterUrl: string,
        pageApiUrl: string
    ): ProviderResult {
        const bestResolution = this.findBestResolution(content);
        if (!bestResolution) {
            return this.emptyResult('no streams found in HLS playlist');
        }

        const requestHeaders = { ...this.HEADERS, Referer: pageApiUrl };
        const sources: Source[] = [
            {
                url: this.streamUrl(masterUrl, requestHeaders),
                type: 'hls',
                quality: `${bestResolution}p`,
                audioTracks: this.parseAudioTracks(content),
                provider: { id: this.id, name: this.name }
            }
        ];

        return {
            sources,
            subtitles: this.parseSubtitles(content, masterUrl, requestHeaders),
            diagnostics: []
        };
    }

    private parseAudioTracks(
        content: string
    ): Array<{ language: string; label: string }> {
        const tracks = content
            .split('\n')
            .filter((line) => line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO'))
            .map((line) => ({
                language: line.match(/LANGUAGE="([^"]+)"/)?.[1] ?? 'unknown',
                label: line.match(/NAME="([^"]+)"/)?.[1] ?? 'Audio'
            }));

        return tracks.length > 0
            ? tracks
            : [{ language: 'en', label: 'English' }];
    }

    private parseSubtitles(
        content: string,
        masterUrl: string,
        headers: Record<string, string>
    ): Subtitle[] {
        return content
            .split('\n')
            .filter((line) => line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES'))
            .flatMap((line) => {
                const uri = line.match(/URI="([^"]+)"/)?.[1];
                if (!uri) return [];

                return [
                    {
                        url: this.streamUrl(new URL(uri, masterUrl).toString(), headers),
                        label: line.match(/NAME="([^"]+)"/)?.[1] ?? 'unknown',
                        format: 'vtt' as const
                    }
                ];
            });
    }

    private streamUrl(url: string, headers: Record<string, string>): string {
        if (process.env.MEDIA_PROXY === 'true') return this.createProxyUrl(url, headers);
        const parsed = new URL(url);
        parsed.searchParams.set('data', encodeURIComponent(JSON.stringify({ url, headers })));
        return parsed.toString();
    }

    private findBestResolution(content: string): number {
        const variantPattern =
            /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=\d+x(\d+)[^\n]*\n([^\n]+)/g;
        let bestResolution = 0;
        let match: RegExpExecArray | null;

        while ((match = variantPattern.exec(content)) !== null) {
            bestResolution = Math.max(
                bestResolution,
                Number.parseInt(match[1], 10)
            );
        }

        return bestResolution;
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
            return response.status === 200;
        } catch {
            return false;
        }
    }
}

