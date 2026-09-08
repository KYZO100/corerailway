/** Plaintext VidZee stream response returned when `e=0` is requested. */
export type PlaintextStreamResponse = {
    url: string;
    language?: string;
    headers?: Record<string, string>;
};
