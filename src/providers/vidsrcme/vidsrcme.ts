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

const BASE_URL = 'https://vidsrcme.ru';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_WASM_BYTES = 1024 * 1024;
const MAX_ENCRYPTED_BYTES = 1024 * 1024;
const MAX_DECRYPTED_BYTES = 5 * 1024 * 1024;
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

type ResolverPayload = { src?: unknown };
type PlayerConfig = { api?: unknown; streamBase?: unknown };
type SubtitlePayload = {
    file?: unknown;
    url?: unknown;
    label?: unknown;
    display?: unknown;
    language?: unknown;
    lang?: unknown;
    format?: unknown;
    type?: unknown;
};
type StreamPayload = {
    data?: { stream_urls?: unknown };
    default_subs?: unknown;
    vs?: { wasm_url?: unknown; wasm?: unknown };
};

type DecoderExports = {
    memory: { buffer: ArrayBuffer };
    alloc(size: number): number;
    decrypt(pointer: number, size: number): number;
};

type WasmRuntime = {
    compile(bytes: Uint8Array): Promise<unknown>;
    instantiate(
        module: unknown,
        imports: Record<string, never>
    ): Promise<{ exports: Record<string, unknown> }>;
    Module: { imports(module: unknown): unknown[] };
};

export class VidSrcMeProvider extends BaseProvider {
    readonly id = 'vidsrcme';
    readonly name = 'VidSrcMe';
    readonly enabled = true;
    readonly BASE_URL = BASE_URL;
    readonly HEADERS = {
        Accept: 'application/json',
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
            return this.emptyResult('missing season or episode number');
        }
        return this.getSources(media);
    }

    private async getSources(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            const resolverUrl = new URL('/vs_src.php', BASE_URL);
            resolverUrl.searchParams.set('type', media.type);
            resolverUrl.searchParams.set('id', media.tmdbId);
            if (media.type === 'tv') {
                resolverUrl.searchParams.set('season', String(media.s));
                resolverUrl.searchParams.set('episode', String(media.e));
            }

            const resolver = await this.fetchJson<ResolverPayload>(
                resolverUrl,
                this.HEADERS
            );
            const outerPlayerUrl = this.safeHttpUrl(resolver.src, BASE_URL);
            if (!outerPlayerUrl) return this.emptyResult('resolver returned no player');

            const outerHtml = await this.fetchText(outerPlayerUrl, {
                Referer: `${BASE_URL}/`,
                'User-Agent': USER_AGENT
            });
            const outerConfig = this.extractWindowConfig(outerHtml, 'CFG');
            const nestedPlayerUrl = this.safeHttpUrl(
                outerConfig.playerUrl,
                outerPlayerUrl
            );
            if (!nestedPlayerUrl) {
                return this.emptyResult('player returned no nested source');
            }

            const nestedHtml = await this.fetchText(nestedPlayerUrl, {
                Referer: outerPlayerUrl.toString(),
                'User-Agent': USER_AGENT
            });
            const playerConfig = this.extractWindowConfig(
                nestedHtml,
                'CONFIG'
            ) as PlayerConfig;
            const apiUrl = this.getStreamApiUrl(
                playerConfig,
                nestedPlayerUrl,
                media
            );
            if (!apiUrl) return this.emptyResult('player returned no stream API');

            const payload = await this.fetchJson<StreamPayload>(apiUrl, {
                Accept: 'application/json',
                Referer: nestedPlayerUrl.toString(),
                'User-Agent': USER_AGENT
            });
            const streamUrls = await this.decodeStreamUrls(payload, apiUrl);
            const authorizedUrls = await this.authorizeStreamUrls(
                streamUrls,
                nestedPlayerUrl
            );
            const proxyHeaders = {
                Origin: nestedPlayerUrl.origin,
                Referer: nestedPlayerUrl.toString(),
                'User-Agent': USER_AGENT
            };
            const sources = this.mapSources(authorizedUrls, proxyHeaders);
            if (sources.length === 0) {
                return this.emptyResult('stream API returned no playable sources');
            }

            return {
                sources,
                subtitles: this.mapSubtitles(payload.default_subs, proxyHeaders),
                diagnostics: []
            };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error ? error.message : 'unknown provider error'
            );
        }
    }

    private getStreamApiUrl(
        config: PlayerConfig,
        playerUrl: URL,
        media: ProviderMediaObject
    ): URL | null {
        const direct = this.safeHttpUrl(config.api, playerUrl);
        if (direct) return direct;
        if (media.type !== 'tv' || !media.s || !media.e) return null;
        const streamBase = this.safeHttpUrl(config.streamBase, playerUrl);
        if (!streamBase) return null;
        streamBase.searchParams.set('season', String(media.s));
        streamBase.searchParams.set('episode', String(media.e));
        streamBase.searchParams.set('stream_urls', '');
        return streamBase;
    }

    private async authorizeStreamUrls(
        urls: string[],
        playerUrl: URL
    ): Promise<string[]> {
        const tokens = new Map<string, Promise<string>>();
        const authorized = await Promise.all(
            urls.map(async (rawUrl) => {
                const url = this.safeHttpUrl(rawUrl);
                if (!url) return '';
                let tokenPromise = tokens.get(url.origin);
                if (!tokenPromise) {
                    tokenPromise = this.fetchStreamToken(url.origin, playerUrl);
                    tokens.set(url.origin, tokenPromise);
                }
                const token = await tokenPromise;
                if (!token) return '';
                if (url.toString().includes('__TOKEN__')) {
                    return url.toString().replaceAll('__TOKEN__', token);
                }
                url.searchParams.set('token', token);
                return url.toString();
            })
        );
        return authorized.filter(Boolean);
    }

    private async fetchStreamToken(
        origin: string,
        playerUrl: URL
    ): Promise<string> {
        const tokenUrl = new URL('/generate.php', origin);
        const response = await this.fetchWithRetry(tokenUrl, {
            headers: {
                Origin: playerUrl.origin,
                Referer: playerUrl.toString(),
                'User-Agent': USER_AGENT
            }
        });
        if (!response.ok) return '';
        const raw = (await response.text()).trim();
        if (!raw || raw.length > 4096) return '';
        if (!raw.startsWith('{') && !raw.startsWith('[')) return raw;
        try {
            const parsed = JSON.parse(raw) as unknown;
            if (typeof parsed === 'string') return parsed.trim();
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return '';
            }
            const object = parsed as Record<string, unknown>;
            return this.stringValue(
                object.token ?? object.data ?? object.string ?? object.result
            );
        } catch {
            return '';
        }
    }
    private async decodeStreamUrls(
        payload: StreamPayload,
        apiUrl: URL
    ): Promise<string[]> {
        const value = payload.data?.stream_urls;
        if (Array.isArray(value)) {
            return value.filter((item): item is string => typeof item === 'string');
        }
        if (typeof value !== 'string' || !value) return [];

        const encrypted = Buffer.from(value, 'base64');
        if (encrypted.length === 0 || encrypted.length > MAX_ENCRYPTED_BYTES) {
            throw new Error('encrypted stream payload is invalid');
        }

        const wasmBytes = await this.getDecoderBytes(payload, apiUrl);
        const wasm = (
            globalThis as unknown as { WebAssembly?: WasmRuntime }
        ).WebAssembly;
        if (!wasm) throw new Error('WebAssembly runtime is unavailable');
        const module = await wasm.compile(wasmBytes);
        if (wasm.Module.imports(module).length > 0) {
            throw new Error('decoder contains unsupported imports');
        }

        const instance = await wasm.instantiate(module, {});
        const exports = instance.exports as unknown as Partial<DecoderExports>;
        if (
            !exports.memory ||
            !(exports.memory.buffer instanceof ArrayBuffer) ||
            typeof exports.alloc !== 'function' ||
            typeof exports.decrypt !== 'function'
        ) {
            throw new Error('decoder exports are invalid');
        }

        const pointer = exports.alloc(encrypted.length);
        if (!Number.isSafeInteger(pointer) || pointer < 0) {
            throw new Error('decoder allocated an invalid buffer');
        }
        const inputEnd = pointer + encrypted.length;
        if (inputEnd > exports.memory.buffer.byteLength) {
            throw new Error('decoder input exceeds memory');
        }
        new Uint8Array(exports.memory.buffer, pointer, encrypted.length).set(
            encrypted
        );

        const outputLength = exports.decrypt(pointer, encrypted.length);
        const outputStart = pointer + 12;
        const outputEnd = outputStart + outputLength;
        if (
            !Number.isSafeInteger(outputLength) ||
            outputLength <= 0 ||
            outputLength > MAX_DECRYPTED_BYTES ||
            outputEnd > exports.memory.buffer.byteLength
        ) {
            throw new Error('decoder returned an invalid output');
        }

        const decoded = new TextDecoder().decode(
            new Uint8Array(exports.memory.buffer, outputStart, outputLength)
        );
        return decoded
            .split('\n')
            .map((url) => url.trim())
            .filter(Boolean);
    }

    private async getDecoderBytes(
        payload: StreamPayload,
        apiUrl: URL
    ): Promise<Uint8Array> {
        const inline = payload.vs?.wasm;
        if (typeof inline === 'string' && inline) {
            const bytes = Buffer.from(inline, 'base64');
            if (bytes.length === 0 || bytes.length > MAX_WASM_BYTES) {
                throw new Error('inline decoder is invalid');
            }
            return bytes;
        }

        const wasmUrl = this.safeHttpUrl(payload.vs?.wasm_url, apiUrl);
        if (!wasmUrl) throw new Error('stream decoder is missing');
        const response = await this.fetchWithRetry(wasmUrl);
        if (!response.ok) {
            throw new Error(`decoder returned ${response.status}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length === 0 || bytes.length > MAX_WASM_BYTES) {
            throw new Error('downloaded decoder is invalid');
        }
        return bytes;
    }

    private mapSources(
        urls: string[],
        headers: Record<string, string>
    ): Source[] {
        const seen = new Set<string>();
        const sources: Source[] = [];
        for (const [index, rawUrl] of urls.entries()) {
            const url = this.safeHttpUrl(rawUrl);
            if (!url || seen.has(url.toString())) continue;
            seen.add(url.toString());
            sources.push({
                url: this.createProxyUrl(url.toString(), headers),
                type: this.inferSourceType(url.toString()),
                quality: 'Auto',
                audioTracks: [{ language: 'und', label: 'Original' }],
                provider: {
                    id: this.id,
                    name: `${this.name} ${index + 1}`
                }
            });
        }
        return sources;
    }

    private mapSubtitles(
        value: unknown,
        headers: Record<string, string>
    ): Subtitle[] {
        if (!Array.isArray(value)) return [];
        const seen = new Set<string>();
        return value.flatMap((item, index) => {
            if (!item || typeof item !== 'object') return [];
            const subtitle = item as SubtitlePayload;
            const url = this.safeHttpUrl(subtitle.file ?? subtitle.url);
            if (!url || seen.has(url.toString())) return [];
            seen.add(url.toString());
            const label = this.stringValue(
                subtitle.label ??
                    subtitle.display ??
                    subtitle.language ??
                    subtitle.lang
            );
            return [
                {
                    url: this.createProxyUrl(url.toString(), headers),
                    label: label || `Subtitle ${index + 1}`,
                    format: this.inferSubtitleFormat(
                        this.stringValue(subtitle.format ?? subtitle.type) ||
                            url.pathname
                    )
                }
            ];
        });
    }

    private extractWindowConfig(
        html: string,
        variable: 'CFG' | 'CONFIG'
    ): Record<string, unknown> {
        const expression = new RegExp(
            `window\\.${variable}\\s*=\\s*(\\{[^;]+\\});`
        );
        const raw = html.match(expression)?.[1];
        if (!raw) throw new Error(`player ${variable} config is missing`);
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`player ${variable} config is invalid`);
        }
        return parsed as Record<string, unknown>;
    }

    private async fetchJson<T>(
        url: URL,
        headers: Record<string, string>
    ): Promise<T> {
        const response = await this.fetchWithRetry(url, { headers });
        if (!response.ok) throw new Error(`request returned ${response.status}`);
        return (await response.json()) as T;
    }

    private async fetchText(
        url: URL,
        headers: Record<string, string>
    ): Promise<string> {
        const response = await this.fetchWithRetry(url, { headers });
        if (!response.ok) throw new Error(`player returned ${response.status}`);
        return response.text();
    }

    private async fetchWithRetry(
        url: URL,
        init: Omit<RequestInit, 'signal'> = {}
    ): Promise<Response> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const response = await fetch(url, {
                    ...init,
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                });
                if (response.status < 500 || attempt === 2) return response;
                await response.body?.cancel();
                lastError = new Error(`request returned ${response.status}`);
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError instanceof Error
            ? lastError
            : new Error('request failed');
    }
    private safeHttpUrl(value: unknown, base?: string | URL): URL | null {
        if (typeof value !== 'string' || !value.trim()) return null;
        try {
            const url = new URL(value, base);
            return url.protocol === 'http:' || url.protocol === 'https:'
                ? url
                : null;
        } catch {
            return null;
        }
    }

    private inferSourceType(url: string): SourceType {
        const value = url.toLowerCase();
        if (value.includes('.m3u8') || value.includes('hls')) return 'hls';
        if (value.includes('.mpd') || value.includes('dash')) return 'dash';
        if (value.includes('.webm')) return 'webm';
        if (value.includes('.mkv')) return 'mkv';
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
