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

const BASE_URL = 'https://www.movy.sx';
const API_BASE = 'https://api.wecollege.net';
const TIMEOUT = 20_000;
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const MIX = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
    0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
    0xc19bf174
];
const MAGIC = [109, 118, 109, 49];

interface MovySeed {
    seed?: unknown;
    ttlMs?: unknown;
}

interface MovyPayload {
    sources?: unknown;
    subtitles?: unknown;
}

interface MovySource {
    url?: unknown;
    file?: unknown;
    type?: unknown;
    quality?: unknown;
    label?: unknown;
}

interface MovySubtitle {
    url?: unknown;
    file?: unknown;
    language?: unknown;
    lang?: unknown;
    label?: unknown;
    type?: unknown;
    format?: unknown;
}

interface CachedSeed {
    seed: string;
    expiresAt: number;
}

const seedCache = new Map<string, CachedSeed>();

export class MovyProvider extends BaseProvider {
    readonly id = 'movy';
    readonly name = 'Movy';
    readonly enabled = true;
    readonly BASE_URL = BASE_URL;
    readonly HEADERS = {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
        'User-Agent': USER_AGENT
    };
    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        if (!media.s || !media.e) {
            return this.emptyProviderResult('missing season or episode number');
        }
        return this.getSources(media);
    }

    private async getSources(
        media: ProviderMediaObject
    ): Promise<ProviderResult> {
        try {
            const params = this.sourceParams(media);
            const endpointNames =
                process.env.MEDIA_PROXY === 'true'
                    ? ['miami']
                    : ['seattle', 'phoenix', 'dallas'];
            const results = await Promise.allSettled(
                endpointNames.map(async (name) => {
                    const decoded = await this.fetchDecodedSources(
                        `${API_BASE}/${name}/sources`,
                        params,
                        media.tmdbId
                    );
                    return JSON.parse(decoded) as MovyPayload;
                })
            );
            const payloads = results.flatMap((result) =>
                result.status === 'fulfilled' ? [result.value] : []
            );
            const sources = this.mapSources(
                payloads.flatMap((payload) =>
                    Array.isArray(payload.sources) ? payload.sources : []
                )
            );

            if (sources.length === 0) {
                return this.emptyProviderResult('no playable sources returned');
            }

            return {
                sources,
                subtitles: this.mapSubtitles(
                    payloads.flatMap((payload) =>
                        Array.isArray(payload.subtitles) ? payload.subtitles : []
                    )
                ),
                diagnostics: []
            };
        } catch (error) {
            return this.emptyProviderResult(
                error instanceof Error ? error.message : 'unknown provider error'
            );
        }
    }


    private emptyProviderResult(reason: string): ProviderResult {
        return { sources: [], subtitles: [], diagnostics: [{ code: 'PROVIDER_ERROR', message: this.name + ': ' + reason, field: '', severity: 'error' }] };
    }
    private sourceParams(media: ProviderMediaObject): Record<string, string> {
        const params: Record<string, string> = {
            title: encodeURIComponent(media.title),
            mediaType: media.type === 'movie' ? 'movie' : 'tv',
            tmdbId: media.tmdbId
        };
        const year = media.releaseYear?.match(/\d{4}/)?.[0];
        if (year) params.year = year;
        if (media.imdbId) params.imdbId = media.imdbId;
        if (media.type === 'tv') {
            params.seasonId = String(media.s);
            params.episodeId = String(media.e);
        }
        return params;
    }

    private mapSources(value: unknown): Source[] {
        if (!Array.isArray(value)) return [];
        const seen = new Set<string>();
        return value.flatMap((rawSource) => {
            if (!rawSource || typeof rawSource !== 'object') return [];
            const source = rawSource as MovySource;
            const url = this.safeHttpUrl(source.url ?? source.file);
            if (!url || seen.has(url.toString())) return [];
            seen.add(url.toString());

            return [
                {
                    url: this.streamUrl(url.toString(), this.HEADERS),
                    type: this.sourceType(
                        this.stringValue(source.type) || url.toString()
                    ),
                    quality: this.quality(
                        this.stringValue(source.quality) ||
                            this.stringValue(source.label)
                    ),
                    audioTracks: [{ language: 'und', label: 'Original' }],
                    provider: { id: this.id, name: this.name }
                }
            ];
        });
    }

    private mapSubtitles(value: unknown): Subtitle[] {
        if (!Array.isArray(value)) return [];
        const seen = new Set<string>();
        return value.flatMap((rawSubtitle, index) => {
            if (!rawSubtitle || typeof rawSubtitle !== 'object') return [];
            const subtitle = rawSubtitle as MovySubtitle;
            const url = this.safeHttpUrl(subtitle.url ?? subtitle.file);
            if (!url || seen.has(url.toString())) return [];
            seen.add(url.toString());

            return [
                {
                    url: this.streamUrl(url.toString(), this.HEADERS),
                    label:
                        this.stringValue(subtitle.label) ||
                        this.stringValue(subtitle.language) ||
                        this.stringValue(subtitle.lang) ||
                        `Subtitle ${index + 1}`,
                    format: this.subtitleFormat(
                        this.stringValue(subtitle.format) ||
                            this.stringValue(subtitle.type) ||
                            url.pathname
                    )
                }
            ];
        });
    }

    private async fetchDecodedSources(
        endpoint: string,
        params: Record<string, string>,
        mediaId: string,
        retried = false
    ): Promise<string> {
        const seed = await this.getSeed(mediaId);
        const url = new URL(endpoint);
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }
        url.searchParams.set('enc', '2');
        url.searchParams.set('seed', seed);

        const response = await fetch(url, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(TIMEOUT)
        });
        if (response.status === 401 && !retried) {
            seedCache.delete(mediaId);
            return this.fetchDecodedSources(endpoint, params, mediaId, true);
        }
        if (!response.ok) {
            throw new Error(`source request failed: ${response.status}`);
        }
        return this.decrypt(await response.text(), seed, mediaId);
    }

    private async getSeed(mediaId: string): Promise<string> {
        const cached = seedCache.get(mediaId);
        if (cached && cached.expiresAt > Date.now() + 5_000) return cached.seed;

        const url = new URL('/seed', API_BASE);
        url.searchParams.set('mediaId', mediaId);
        const response = await fetch(url, {
            headers: this.HEADERS,
            signal: AbortSignal.timeout(TIMEOUT)
        });
        if (!response.ok)
            throw new Error(`seed request failed: ${response.status}`);
        const payload = (await response.json()) as MovySeed;
        const seed = this.stringValue(payload.seed);
        if (!seed) throw new Error('seed request returned no seed');

        const ttlMs = Number(payload.ttlMs);
        seedCache.set(mediaId, {
            seed,
            expiresAt: Date.now() + (Number.isFinite(ttlMs) ? ttlMs : 30_000)
        });
        return seed;
    }

    private decrypt(payload: string, seed: string, mediaId: string): string {
        const encrypted = this.base64UrlDecode(payload);
        const keyStream = this.keyStream(seed, mediaId, encrypted.length);
        for (let index = 0; index < encrypted.length; index += 1) {
            encrypted[index] ^= keyStream[index];
        }
        for (let index = 0; index < MAGIC.length; index += 1) {
            if (encrypted[index] !== MAGIC[index]) {
                throw new Error('decrypt failed: bad seed or tampered payload');
            }
        }
        return new TextDecoder().decode(encrypted.subarray(MAGIC.length));
    }

    private keyStream(seed: string, mediaId: string, size: number): Uint8Array {
        const state = this.seedState(seed, mediaId, size);
        const output = new Uint8Array(size);
        let counter = 0;
        for (let index = 0; index < size; ) {
            const value = this.nextWord(state, counter);
            counter += 1;
            output[index] = value & 255;
            index += 1;
            if (index < size) {
                output[index] = (value >>> 8) & 255;
                index += 1;
            }
            if (index < size) {
                output[index] = (value >>> 16) & 255;
                index += 1;
            }
            if (index < size) {
                output[index] = (value >>> 24) & 255;
                index += 1;
            }
        }
        return output;
    }

    private seedState(
        seed: string,
        mediaId: string,
        size: number
    ): { S: number[]; acc: number } {
        if (this.isOddTriangle(seed.length)) {
            return {
                S: this.rc4State(seed),
                acc: this.seedAccumulator(seed)
            };
        }

        const S = new Array<number>(61);
        let acc = this.mix32(
            this.fnv(seed) ^ this.mix32((Number(mediaId) >>> 0) ^ 0x9e3779b9)
        );
        for (let index = 0; index < 8; index += 1) {
            if (this.isEvenTriangle(index)) {
                const position = acc % 61;
                acc = this.rotl((acc + 0x9e3779b9) >>> 0, 7 + (index & 7));
                S[position] = (acc ^ this.mix32(acc)) >>> 0;
                acc = this.mix32((acc + position) >>> 0);
            } else {
                S[index] = MIX[index & 15];
            }
        }
        return { S, acc: this.mix32((0xa5a5a5a5 ^ acc) >>> 0) };
    }

    private nextWord(
        state: { S: number[]; acc: number },
        counter: number
    ): number {
        const index = state.acc % 61;
        const mask = index in state.S ? 0xffffffff : 0;
        const slot = state.S[index] >>> 0;
        const counterMix = Math.imul(0x9e3779b9, counter + 1) >>> 0;
        const hidden =
            ((state.acc ^ (slot ^ counterMix)) >>> 0) |
            ((state.acc & (slot ^ counterMix) & mask) >>> 0);
        const rotated =
            this.rotl((hidden + state.acc) >>> 0, index & 31) ^
            this.rotl(state.acc, Math.imul(index, 7) & 31);
        state.acc = this.mix32((rotated + 0x9e3779b9) >>> 0);
        state.S[index] = state.acc;
        return state.acc;
    }

    private base64UrlDecode(value: string): Uint8Array {
        const base64 = value
            .replace(/-/g, '+')
            .replace(/_/g, '/')
            .padEnd(4 * Math.ceil(value.length / 4), '=');
        return new Uint8Array(Buffer.from(base64, 'base64'));
    }

    private rc4State(seed: string): number[] {
        const S = Array.from({ length: 256 }, (_, index) => index);
        let j = 0;
        for (let index = 0; index < 256; index += 1) {
            j = (j + S[index] + seed.charCodeAt(index % seed.length)) & 255;
            const current = S[index];
            S[index] = S[j];
            S[j] = current;
        }
        return S;
    }

    private seedAccumulator(seed: string): number {
        let acc = 0x67452301;
        for (let index = 0; index < seed.length; index += 1) {
            acc = this.rotl(
                (acc ^ Math.imul(seed.charCodeAt(index), MIX[index & 15])) >>>
                    0,
                5
            );
        }
        return this.mix32(acc);
    }

    private fnv(seed: string): number {
        let value = 0x811c9dc5;
        for (let index = 0; index < seed.length; index += 1) {
            value = Math.imul(value ^ seed.charCodeAt(index), 0x1000193) >>> 0;
        }
        return this.mix32(value);
    }

    private mix32(value: number): number {
        value >>>= 0;
        value ^= value >>> 16;
        value = Math.imul(value, 0x85ebca6b) >>> 0;
        value ^= value >>> 13;
        value = Math.imul(value, 0xc2b2ae35) >>> 0;
        return (value ^ (value >>> 16)) >>> 0;
    }

    private rotl(value: number, shift: number): number {
        value >>>= 0;
        shift &= 31;
        return shift === 0
            ? value
            : ((value << shift) | (value >>> (32 - shift))) >>> 0;
    }

    private isEvenTriangle(value: number): boolean {
        return ((value * (value + 1)) & 1) === 0;
    }

    private isOddTriangle(value: number): boolean {
        return ((value * (value + 1)) & 1) === 1;
    }

    private safeHttpUrl(value: unknown): URL | null {
        if (typeof value !== 'string') return null;
        try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:'
                ? url
                : null;
        } catch {
            return null;
        }
    }

    private stringValue(value: unknown): string {
        return typeof value === 'string' ? value.trim() : '';
    }

    private streamUrl(url: string, headers: Record<string, string>): string {
        if (process.env.MEDIA_PROXY === 'true') return this.createProxyUrl(url, headers);
        const parsed = new URL(url);
        parsed.searchParams.set('data', encodeURIComponent(JSON.stringify({ url, headers })));
        return parsed.toString();
    }

    private sourceType(value: string): SourceType {
        const normalized = value.toLowerCase();
        if (normalized.includes('dash') || normalized.includes('.mpd'))
            return 'dash';
        if (normalized.includes('hls') || normalized.includes('.m3u8'))
            return 'hls';
        return 'mp4';
    }

    private quality(value: string): string {
        const normalized = value.trim();
        if (!normalized) return 'Auto';
        const height = normalized.match(/(\d{3,4})p?/i)?.[1];
        return height ? `${height}p` : normalized;
    }

    private subtitleFormat(value: string): SubtitleFormat {
        const normalized = value.toLowerCase();
        if (normalized.includes('srt')) return 'srt';
        if (normalized.includes('ass')) return 'ass';
        return 'vtt';
    }
}








