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

const BASE_URL = 'https://embed.vidrift.in';
const MEDIA_URL = 'https://media.vidrift.in';
const TIMEOUT = 15_000;
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const SUBTITLES = [
    ['en', 'English'],
    ['es', 'Spanish'],
    ['fr', 'French'],
    ['de', 'German'],
    ['it', 'Italian'],
    ['pt', 'Portuguese'],
    ['cs', 'Czech'],
    ['sk', 'Slovak'],
    ['pl', 'Polish'],
    ['tr', 'Turkish']
] as const;

export class VidriftProvider extends BaseProvider {
    readonly id = 'vidrift';
    readonly name = 'Vidrift';
    readonly enabled = true;
    readonly BASE_URL = BASE_URL;
    readonly HEADERS = {
        Accept: 'application/vnd.apple.mpegurl,application/x-mpegurl,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: `${BASE_URL}/`,
        Origin: BASE_URL,
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
            return this.empty('missing season or episode number');
        }
        return this.getSources(media);
    }

    private getSources(media: ProviderMediaObject): ProviderResult {
        const stream = this.streamUrlFor(media);
        const source: Source = {
            url: this.streamUrl(stream, this.HEADERS),
            type: this.sourceType(stream),
            quality: 'Auto',
            audioTracks: [{ language: 'und', label: 'Original' }],
            provider: { id: this.id, name: this.name }
        };

        return {
            sources: [source],
            subtitles: this.subtitlesFor(media),
            diagnostics: []
        };
    }

    private streamUrlFor(media: ProviderMediaObject): string {
        if (media.type === 'movie') {
            return `${MEDIA_URL}/movie_${encodeURIComponent(media.tmdbId)}/vod.m3u8`;
        }
        const season = Number(media.s);
        const episode = Number(media.e);
        const seasonFolder = `Season ${season}`;
        const episodeFolder = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
        return `${MEDIA_URL}/tv_${encodeURIComponent(media.tmdbId)}/${encodeURIComponent(seasonFolder)}/${episodeFolder}/vod.m3u8`;
    }

    private subtitlesFor(media: ProviderMediaObject): Subtitle[] {
        return SUBTITLES.map(([code, label]) => ({
            url: this.streamUrl(this.subtitleUrl(media, label), this.HEADERS),
            label,
            format: 'vtt' as SubtitleFormat
        }));
    }

    private subtitleUrl(media: ProviderMediaObject, label: string): string {
        if (media.type === 'movie') {
            return `${BASE_URL}/api/subtitles/movie/${encodeURIComponent(media.tmdbId)}/${encodeURIComponent(label)}`;
        }
        return `${BASE_URL}/api/subtitles/tv/${encodeURIComponent(media.tmdbId)}/${media.s}/${media.e}/${encodeURIComponent(label)}`;
    }

    private streamUrl(url: string, headers: Record<string, string>): string {
        if (process.env.MEDIA_PROXY === 'true') return this.createProxyUrl(url, headers);
        const parsed = new URL(url);
        parsed.searchParams.set('data', encodeURIComponent(JSON.stringify({ url, headers })));
        return parsed.toString();
    }

    private sourceType(value: string): SourceType {
        const normalized = value.toLowerCase();
        if (normalized.includes('.mpd')) return 'dash';
        if (normalized.includes('.m3u8')) return 'hls';
        return 'mp4';
    }

    private empty(message: string): ProviderResult {
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
}
