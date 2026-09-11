import { BaseProvider } from '@omss/framework';
import type { ProviderCapabilities, ProviderMediaObject, ProviderResult, Source, SourceType } from '@omss/framework';
import * as cheerio from 'cheerio';

const PSTREAM = 'https://fed-api.pstream.mov';
const SHOWBOX = 'https://www.showbox.media';
const FEBBOX = 'https://www.febbox.com';
const TIMEOUT = 30_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
type PStreamPayload = { streams?: Record<string, unknown>; sources?: Array<{ url?: unknown; quality?: unknown }>; data?: Array<{ url?: unknown; file?: unknown; quality?: unknown; label?: unknown }> };
type RawSource = { url: string; label: string };
type Share = { url: string; title: string };
type FileEntry = { fid: string; name: string; episode: number };

export class ShowboxProvider extends BaseProvider {
    readonly id = 'showbox';
    readonly name = 'Showbox';
    readonly enabled = true;
    readonly BASE_URL = SHOWBOX;
    readonly HEADERS = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': UA };
    readonly capabilities: ProviderCapabilities = { supportedContentTypes: ['movies', 'tv'] };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> { return this.getSources(media); }
    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        if (media.s == null || media.e == null) return this.empty('missing season or episode number');
        return this.getSources(media);
    }

    private async getSources(media: ProviderMediaObject): Promise<ProviderResult> {
        const sources: Source[] = [];
        try {
            const share = await this.findShare(media);
            if (share) {
                const raw = media.type === 'tv' ? await this.episodeSources(share, media.s!, media.e!) : await this.fileSources(share.url);
                const febboxSources = raw.map((item) => this.mapSource(item)).filter((item): item is Source => item !== null);
                sources.push(...febboxSources);
            }
        } catch {}

        const primary = await this.pstream(media);
        sources.push(...primary);

        if (sources.length) return this.result(sources);

        // PStream/FEBBox requires this token from many cloud-provider egress
        // ranges. Keep the provider enabled without it for local compatibility,
        // but make a missing deployment secret actionable in diagnostics.
        if (!process.env.SHOWBOX_UI_TOKEN?.trim()) {
            return this.empty('No playable sources found; configure SHOWBOX_UI_TOKEN in the deployment environment');
        }
        return this.empty('No playable sources found');
    }

    private async pstream(media: ProviderMediaObject): Promise<Source[]> {
        if (!media.imdbId) return [];
        try {
            const path = media.type === 'movie' ? `/movie/${encodeURIComponent(media.imdbId)}` : `/tv/${encodeURIComponent(media.imdbId)}/${media.s}/${media.e}`;
            const url = new URL(path, PSTREAM);
            const headers: Record<string, string> = { Accept: 'pstream.org', 'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8', Origin: 'https://pstream.mov', Referer: `https://pstream.mov/media/tmdb-${media.type}-${media.imdbId}`, 'User-Agent': UA };
            if (process.env.SHOWBOX_REGION) headers.region = process.env.SHOWBOX_REGION;
            if (process.env.SHOWBOX_UI_TOKEN) headers['ui-token'] = process.env.SHOWBOX_UI_TOKEN.trim();
            const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
            if (!response.ok) return [];
            const payload = await response.json() as PStreamPayload;
            const candidates: Array<{ url: unknown; quality: unknown }> = [];
            if (payload.streams && typeof payload.streams === 'object') for (const [quality, sourceUrl] of Object.entries(payload.streams)) candidates.push({ url: sourceUrl, quality });
            else if (Array.isArray(payload.sources)) candidates.push(...payload.sources.map((source) => ({ url: source.url, quality: source.quality })));
            else if (Array.isArray(payload.data)) candidates.push(...payload.data.map((source) => ({ url: source.url ?? source.file, quality: source.quality ?? source.label })));
            const seen = new Set<string>();
            return candidates.flatMap(({ url: sourceUrl, quality }) => {
                const parsed = this.httpUrl(sourceUrl);
                if (!parsed || seen.has(parsed)) return [];
                seen.add(parsed);
                return [{ url: this.streamUrl(parsed, headers), type: this.sourceType(parsed) as SourceType, quality: this.quality(quality), audioTracks: [{ language: 'und', label: 'Original' }], provider: { id: this.id, name: this.name } }];
            });
        } catch { return []; }
    }
    private async findShare(media: ProviderMediaObject): Promise<Share | null> {
        const title = media.title.trim();
        const year = media.releaseYear?.match(/\d{4}/)?.[0] ?? '';
        const type = media.type === 'movie' ? 'movie' : 'tv';
        const prefix = media.type === 'movie' ? 'm' : 't';
        const slug = this.slug(title);
        for (const page of [`${SHOWBOX}/${type}/${prefix}-${slug}-${year}`, `${SHOWBOX}/${type}/${prefix}-${slug}`]) {
            if (!slug) break;
            try {
                const html = await this.text(page, this.HEADERS);
                const id = this.showboxId(page, html);
                if (id) {
                    const link = await this.shareLink(id, media.type === 'movie' ? 1 : 2);
                    if (link) return { url: link, title };
                }
            } catch { /* try search */ }
        }
        const search = new URL('/search', SHOWBOX);
        search.searchParams.set('keyword', `${title} ${year}`.trim());
        const $ = cheerio.load(await this.text(search.toString(), this.HEADERS));
        let bestId: string | null = null;
        let bestScore = -Infinity;
        let bestTitle = title;
        $('div.film-poster a.film-poster-ahref').each((_, element) => {
            const href = $(element).attr('href') ?? '';
            const itemTitle = $(element).attr('title')?.trim() ?? '';
            const id = href.match(new RegExp(`/${type}/detail/(\\d+)`))?.[1];
            if (!id) return;
            const a = this.normalize(itemTitle), b = this.normalize(title);
            let score = a === b ? 40 : 0;
            if (a.includes(b) || b.includes(a)) score += 15;
            if (year && (itemTitle.includes(year) || href.endsWith(year))) score += 20;
            if (score > bestScore) { bestId = id; bestScore = score; bestTitle = itemTitle || title; }
        });
        if (!bestId || bestScore < 20) return null;
        const link = await this.shareLink(bestId, media.type === 'movie' ? 1 : 2);
        return link ? { url: link, title: bestTitle } : null;
    }

    private async shareLink(id: string, type: 1 | 2): Promise<string | null> {
        const url = new URL('/index/share_link', SHOWBOX);
        url.searchParams.set('id', id); url.searchParams.set('type', String(type));
        try {
            const response = await fetch(url, { headers: { ...this.HEADERS, Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest', Referer: `${SHOWBOX}/` }, signal: AbortSignal.timeout(TIMEOUT) });
            if (!response.ok) return null;
            const payload = await response.json() as { code?: number; data?: { link?: string } };
            return payload.code === 1 ? payload.data?.link ?? null : null;
        } catch { return null; }
    }

    private async fileSources(url: string): Promise<RawSource[]> {
        const html = await this.text(url, this.febboxHeaders(url));
        const direct = this.extractSources(html);
        if (direct.length) return direct;
        const key = this.shareKey(url, html);
        if (!key) return [];
        const resolved = await Promise.all(this.files(html).map((file) => this.fidSources(file.fid, key)));
        return resolved.flat();
    }

    private async episodeSources(share: Share, season: number, episode: number): Promise<RawSource[]> {
        const html = await this.text(share.url, this.febboxHeaders(share.url));
        const key = this.shareKey(share.url, html);
        if (!key) return [];
        const $ = cheerio.load(html);
        const folders = $('div.file.open_dir').map((_, element) => ({ id: $(element).attr('data-id') ?? '', name: $(element).find('p.file_name').text().trim() })).get().filter((folder) => /^\d+$/.test(folder.id));
        if (!folders.length) return this.fileSources(share.url);
        const folder = folders.find((item) => this.season(item.name) === season) ?? folders[season - 1];
        if (!folder) return [];
        const url = new URL('/file/file_share_list', FEBBOX);
        url.searchParams.set('share_key', key); url.searchParams.set('parent_id', folder.id); url.searchParams.set('is_html', '1'); url.searchParams.set('pwd', '');
        const data = await this.jsonOrText(url.toString(), { ...this.febboxHeaders(share.url), 'X-Requested-With': 'XMLHttpRequest' });
        const folderHtml = typeof data === 'string' ? data : data?.html;
        if (!folderHtml) return [];
        const files = this.files(folderHtml).sort((a, b) => a.episode - b.episode);
        const selected = files.find((file) => file.episode === episode) ?? files[episode - 1];
        return selected ? this.fidSources(selected.fid, key) : [];
    }

    private async fidSources(fid: string, key: string): Promise<RawSource[]> {
        const response = await fetch(`${FEBBOX}/file/player`, { method: 'POST', headers: { ...this.febboxHeaders(`${FEBBOX}/share/${key}`), 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Accept: '*/*' }, body: new URLSearchParams({ fid, share_key: key }), signal: AbortSignal.timeout(TIMEOUT) });
        if (!response.ok) return [];
        const text = await response.text();
        const direct = this.extractSources(text);
        if (direct.length) return direct;
        return this.httpUrl(text.trim()) && /\.(?:m3u8|mp4)(?:\?|$)/i.test(text.trim()) ? [{ url: text.trim(), label: 'DirectLink' }] : [];
    }
    private extractSources(html: string): RawSource[] {
        const match = html.match(/var\s+sources\s*=\s*(.*?);\s*/s);
        if (!match) return [];
        try {
            const entries = JSON.parse(match[1]) as Array<{ file?: unknown; label?: unknown }>;
            return entries.flatMap((entry) => typeof entry.file === 'string' && typeof entry.label === 'string' ? [{ url: entry.file, label: entry.label }] : []);
        } catch { return []; }
    }

    private files(html: string): FileEntry[] {
        const $ = cheerio.load(html);
        return $('div.file').map((_, element) => {
            const item = $(element), fid = item.attr('data-id') ?? '', name = item.find('p.file_name').text().trim() || `File_${fid}`;
            return { fid, name, episode: this.episodeNumber(name) };
        }).get().filter((file) => /^\d+$/.test(file.fid) && !Number.isNaN(file.episode));
    }

    private mapSource(raw: RawSource): Source | null {
        const url = this.httpUrl(raw.url);
        if (!url) return null;
        return { url: this.streamUrl(url, this.febboxHeaders(raw.url)), type: this.sourceType(url) as SourceType, quality: this.quality(raw.label), audioTracks: [{ language: 'und', label: 'Original' }], provider: { id: this.id, name: this.name } };
    }

    private async text(url: string, headers: Record<string, string>): Promise<string> {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
        if (!response.ok) throw new Error(`request returned ${response.status}`);
        return response.text();
    }

    private async jsonOrText(url: string, headers: Record<string, string>): Promise<any> {
        const text = await this.text(url, headers);
        try { return JSON.parse(text); } catch { return text; }
    }

    private febboxHeaders(referer: string): Record<string, string> {
        const configured = process.env.SHOWBOX_UI_TOKEN?.trim() ?? '';
        const token = configured.startsWith('ui=') ? configured.slice(3) : configured;
        const region = process.env.SHOWBOX_REGION || 'USA7';
        const cookie = token.includes('oss_group=') ? token : `${token}; oss_group=${region}`;
        return { Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9', Cookie: `ui=${cookie}`, Referer: referer, 'User-Agent': UA };
    }

    private showboxId(url: string, html: string): string | null {
        const direct = url.match(/\/detail\/(\d+)/)?.[1];
        if (direct) return direct;
        const $ = cheerio.load(html);
        const href = $('h2.heading-name a[href*="/detail/"], h1.heading-name a[href*="/detail/"]').first().attr('href');
        return href?.match(/\/detail\/(\d+)/)?.[1] ?? html.match(/data-url="[^"]*\/detail\/(\d+)/)?.[1] ?? null;
    }

    private shareKey(url: string, html: string): string | null {
        return url.match(/\/share\/([A-Za-z0-9-]+)/)?.[1] ?? html.match(/(?:var\s+share_key\s*=|share_key\s*:|shareid=)["']?([A-Za-z0-9-]+)/)?.[1] ?? null;
    }

    private season(value: string): number | null {
        const match = value.match(/(?:season\s*|s)(\d+)/i) ?? value.match(/\b(\d+)\b/);
        return match ? Number(match[1]) : null;
    }

    private episodeNumber(value: string): number {
        const match = value.match(/[._\s-](?:s\d{1,2}[._\s-]?)?e(?:p)?[._\s-]?(\d{1,3})/i) ?? value.match(/episode[._\s-]?(\d{1,3})/i) ?? value.match(/\b(?:ep|part|pt)[._\s-]?(\d{1,3})\b/i);
        if (match) return Number(match[1]);
        const standalone = value.match(/(?<![A-Za-z0-9])(\d{1,3})(?![A-Za-z0-9])/);
        return standalone && Number(standalone[1]) < 200 ? Number(standalone[1]) : Number.NaN;
    }

    private slug(value: string): string { return value.toLowerCase().trim().replace(/&/g, 'and').replace(/[_\s]+/g, '-').replace(/[^\w-]+/g, '').replace(/--+/g, '-').replace(/^-+|-+$/g, ''); }
    private normalize(value: string): string { return value.toLowerCase().replace(/\(?\d{4}\)?$/, '').replace(/[^a-z0-9]/g, ''); }
    private httpUrl(value: unknown): string | null { if (typeof value !== 'string' || !value.trim()) return null; try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null; } catch { return null; } }
    private streamUrl(url: string, headers: Record<string, string>): string { if (process.env.MEDIA_PROXY === 'true') return this.createProxyUrl(url, headers); const parsed = new URL(url); parsed.searchParams.set('data', encodeURIComponent(JSON.stringify({ url, headers }))); return parsed.toString(); }
    private sourceType(url: string): 'hls' | 'mp4' { return /\.m3u8(?:$|\?)/i.test(url) ? 'hls' : 'mp4'; }
    private quality(value: unknown): string { const label = String(value ?? '').toLowerCase(); if (label.includes('2160') || label.includes('4k') || label.includes('uhd')) return '2160p'; if (label.includes('1440')) return '1440p'; if (label.includes('1080')) return '1080p'; if (label.includes('720') || label.includes('hd')) return '720p'; if (label.includes('480') || label.includes('sd')) return '480p'; if (label.includes('360')) return '360p'; return 'ORG'; }
    private result(sources: Source[]): ProviderResult { return { sources, subtitles: [], diagnostics: [] }; }
    private empty(message: string): ProviderResult { return { sources: [], subtitles: [], diagnostics: [{ code: 'PROVIDER_ERROR', message: `${this.name}: ${message}`, field: '', severity: 'error' }] }; }

    async healthCheck(): Promise<boolean> {
        try { const response = await fetch(this.BASE_URL, { method: 'HEAD', headers: this.HEADERS, signal: AbortSignal.timeout(10_000) }); return response.status < 500; } catch { return false; }
    }
}





