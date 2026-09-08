import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    Subtitle,
    SubtitleFormat
} from '@omss/framework';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const BASE_URL = 'https://vidlink.pro';
const API_BASE = `${BASE_URL}/api/b`;
const ENCRYPTION_URL = 'https://enc-dec.app/api/enc-vidlink';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const TOKEN_CACHE_TTL_MS = 30 * 60_000;
const TOKEN_CACHE_MAX_ENTRIES = 256;
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

type EncryptionResponse = {
    result?: unknown;
};

type VidLinkCaption = {
    url?: unknown;
    language?: unknown;
    type?: unknown;
};

type VidLinkFile = {
    url?: unknown;
    type?: unknown;
};

type VidLinkStream = {
    type?: unknown;
    deliveryType?: unknown;
    playlist?: unknown;
    playlistHeaders?: unknown;
    headers?: unknown;
    qualities?: unknown;
    captions?: unknown;
    playbackMetadata?: {
        resolutions?: unknown;
    };
};

type VidLinkResponse = {
    stream?: VidLinkStream;
};

type CachedToken = {
    value: string;
    expiresAt: number;
};

const tokenCache = new Map<string, CachedToken>();

export class VidLinkProvider extends BaseProvider {
    readonly id = 'vidlink';
    readonly name = 'VidLink';
    readonly enabled = true;
    readonly BASE_URL = BASE_URL;
    readonly HEADERS = {
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
        'User-Agent': USER_AGENT,
        // This selects VidLink's signed DASH path. Other modes return MP4 files
        // which are marked as proxy-only and commonly answer HTTP 429.
        'X-Playback-Environment': 'webkit'
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
        try {
            const encryptedId = await this.encryptTmdbId(media.tmdbId);
            const path =
                media.type === 'movie'
                    ? `movie/${encodeURIComponent(encryptedId)}`
                    : `tv/${encodeURIComponent(encryptedId)}/${media.s}/${media.e}`;
            const payload = await this.fetchJson<VidLinkResponse>(
                new URL(path, `${API_BASE}/`),
                this.HEADERS
            );
            const stream = payload?.stream;
            if (!stream) return this.emptyResult('no stream returned');

            const streamHeaders = {
                ...this.HEADERS,
                ...this.safeHeaders(stream.headers),
                ...this.safeHeaders(stream.playlistHeaders)
            };
            const sources = this.mapSources(stream, streamHeaders);
            if (sources.length === 0) {
                return this.emptyResult(
                    'no playable DASH or HLS source returned'
                );
            }

            return {
                sources,
                subtitles: this.mapSubtitles(stream.captions),
                diagnostics: []
            };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error
                    ? error.message
                    : 'unknown provider error'
            );
        }
    }

    private mapSources(
        stream: VidLinkStream,
        headers: Record<string, string>
    ): Source[] {
        const sources: Source[] = [];
        const playlist = this.safeHttpUrl(stream.playlist);
        if (playlist) {
            const deliveryType = this.stringValue(
                stream.deliveryType
            ).toLowerCase();
            const type =
                deliveryType === 'dash' || playlist.pathname.endsWith('.mpd')
                    ? ('dash' as const)
                    : ('hls' as const);
            sources.push({
                url: this.createVidLinkProxyUrl(playlist.toString(), headers),
                type,
                quality: this.highestResolution(stream) ?? 'Auto',
                audioTracks: [{ language: 'und', label: 'Original' }],
                provider: { id: this.id, name: this.name }
            });
            return sources;
        }

        // Kept as a conservative fallback for titles where VidLink has only a
        // file source. The webkit response normally uses the DASH branch above.
        if (!stream.qualities || typeof stream.qualities !== 'object')
            return [];
        for (const [quality, rawFile] of Object.entries(stream.qualities)) {
            if (!rawFile || typeof rawFile !== 'object') continue;
            const file = rawFile as VidLinkFile;
            const url = this.safeHttpUrl(file.url);
            if (!url) continue;
            sources.push({
                url: this.createProxyUrl(url.toString(), headers),
                type: 'mp4',
                quality: /^\d+$/.test(quality)
                    ? `${quality}p`
                    : quality || 'Auto',
                audioTracks: [{ language: 'und', label: 'Original' }],
                provider: { id: this.id, name: this.name }
            });
        }
        return sources;
    }

    private mapSubtitles(value: unknown): Subtitle[] {
        if (!Array.isArray(value)) return [];
        const seen = new Set<string>();
        const headers = {
            Origin: BASE_URL,
            Referer: `${BASE_URL}/`,
            'User-Agent': USER_AGENT
        };
        return value.flatMap((rawCaption, index) => {
            if (!rawCaption || typeof rawCaption !== 'object') return [];
            const caption = rawCaption as VidLinkCaption;
            const url = this.safeHttpUrl(caption.url);
            if (!url || seen.has(url.toString())) return [];
            seen.add(url.toString());
            return [
                {
                    url: this.createProxyUrl(url.toString(), headers),
                    label:
                        this.stringValue(caption.language) ||
                        `Subtitle ${index + 1}`,
                    format: this.subtitleFormat(
                        this.stringValue(caption.type) || url.pathname
                    )
                }
            ];
        });
    }

    private highestResolution(stream: VidLinkStream): string | null {
        const values = stream.playbackMetadata?.resolutions;
        if (!Array.isArray(values)) return null;
        const heights = values
            .map((value) => Number.parseInt(String(value), 10))
            .filter((value) => Number.isFinite(value) && value > 0);
        return heights.length > 0 ? `${Math.max(...heights)}p` : null;
    }

    private async encryptTmdbId(tmdbId: string): Promise<string> {
        const cached = tokenCache.get(tmdbId);
        if (cached && cached.expiresAt > Date.now()) return cached.value;
        tokenCache.delete(tmdbId);

        const url = new URL(ENCRYPTION_URL);
        url.searchParams.set('text', tmdbId);
        let payload: EncryptionResponse;
        try {
            payload = await this.fetchJson<EncryptionResponse>(url, {
                Accept: 'application/json',
                'User-Agent': USER_AGENT
            });
        } catch (error) {
            if (!this.isDnsError(error)) throw error;
            payload = await this.fetchEncryptionWithDnsFallback(url);
        }

        const token = this.stringValue(payload.result);
        if (!/^[A-Za-z0-9_-]{40,256}$/.test(token)) {
            throw new Error('encryption service returned an invalid token');
        }
        this.rememberToken(tmdbId, token);
        return token;
    }

    private rememberToken(tmdbId: string, value: string): void {
        tokenCache.delete(tmdbId);
        tokenCache.set(tmdbId, {
            value,
            expiresAt: Date.now() + TOKEN_CACHE_TTL_MS
        });
        while (tokenCache.size > TOKEN_CACHE_MAX_ENTRIES) {
            const oldest = tokenCache.keys().next();
            if (oldest.done) break;
            tokenCache.delete(oldest.value);
        }
    }

    private async fetchEncryptionWithDnsFallback(
        url: URL
    ): Promise<EncryptionResponse> {
        const dnsUrl = new URL('https://dns.google/resolve');
        dnsUrl.searchParams.set('name', url.hostname);
        dnsUrl.searchParams.set('type', 'A');
        const dns = await this.fetchJson<{
            Answer?: Array<{ type?: number; data?: string }>;
        }>(dnsUrl, { Accept: 'application/dns-json' });
        const address = dns.Answer?.find(
            (answer) => answer.type === 1 && isIP(answer.data ?? '') === 4
        )?.data;
        if (!address) throw new Error('encryption service DNS lookup failed');

        const text = await new Promise<string>((resolve, reject) => {
            const request = httpsRequest(
                url,
                {
                    headers: {
                        Accept: 'application/json',
                        'User-Agent': USER_AGENT
                    },
                    lookup: (_hostname, options, callback) => {
                        if (options.all) {
                            callback(null, [{ address, family: 4 }]);
                            return;
                        }
                        callback(null, address, 4);
                    },
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                },
                (response) => {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    response.on('data', (chunk: Buffer) => {
                        size += chunk.length;
                        if (size > MAX_RESPONSE_BYTES) {
                            request.destroy(new Error('response is too large'));
                            return;
                        }
                        chunks.push(chunk);
                    });
                    response.on('end', () => {
                        if (
                            !response.statusCode ||
                            response.statusCode >= 400
                        ) {
                            reject(
                                new Error(
                                    `encryption service returned ${response.statusCode ?? 0}`
                                )
                            );
                            return;
                        }
                        resolve(Buffer.concat(chunks).toString('utf8'));
                    });
                }
            );
            request.on('error', reject);
            request.end();
        });
        return this.parseJson<EncryptionResponse>(text);
    }

    private async fetchJson<T>(
        url: URL,
        headers: Record<string, string>
    ): Promise<T> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const response = await fetch(url, {
                    headers,
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                });
                if (!response.ok) {
                    if (response.status >= 500 && attempt === 0) {
                        await response.body?.cancel();
                        continue;
                    }
                    throw new Error(`request returned ${response.status}`);
                }
                const text = await response.text();
                if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
                    throw new Error('response is too large');
                }
                return this.parseJson<T>(text);
            } catch (error) {
                lastError = error;
                if (this.isDnsError(error) || attempt === 1) break;
            }
        }
        throw lastError instanceof Error
            ? lastError
            : new Error('request failed');
    }

    private parseJson<T>(text: string): T {
        try {
            return JSON.parse(text) as T;
        } catch {
            throw new Error('request returned invalid JSON');
        }
    }

    private safeHeaders(value: unknown): Record<string, string> {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return {};
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

    private safeHttpUrl(value: unknown): URL | null {
        if (typeof value !== 'string' || !value.trim()) return null;
        try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:'
                ? url
                : null;
        } catch {
            return null;
        }
    }

    private createVidLinkProxyUrl(
        url: string,
        headers: Record<string, string>
    ): string {
        const proxyUrl = new URL(this.createProxyUrl(url, headers));
        proxyUrl.pathname = '/v1/vidlink-proxy';
        return proxyUrl.toString();
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

    private isDnsError(error: unknown): boolean {
        let current: unknown = error;
        for (let depth = 0; depth < 4; depth++) {
            if (!current || typeof current !== 'object') return false;
            if ((current as { code?: unknown }).code === 'ENOTFOUND')
                return true;
            current = (current as { cause?: unknown }).cause;
        }
        return false;
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
            const response = await fetch(BASE_URL, {
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
