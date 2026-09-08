/** Decrypted response returned by a Videasy source endpoint. */
export interface VideasyDecryptedPayload {
    sources: VideasyRawSource[];
    subtitles?: VideasyRawSubtitle[];
}

export interface VideasyRawSource {
    url: string;
    quality?: string;
    type?: string;
}

export interface VideasyRawSubtitle {
    url: string;
    label?: string;
    language?: string;
    lang?: string;
}

/** A Videasy source route and the media types it supports. */
export interface VideasyServer {
    readonly name: string;
    readonly url: string;
    readonly moviesOnly?: boolean;
}
