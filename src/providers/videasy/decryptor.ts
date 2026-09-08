import type { VideasyDecryptedPayload } from './videasy.types.js';

const MAGIC = [109, 118, 109, 49] as const; // "mvm1"

interface StreamState {
    stream: Array<number | undefined>;
    accumulator: number;
}

function u32(value: number): number {
    return value >>> 0;
}

function multiply32(left: number, right: number): number {
    return Math.imul(left, right) >>> 0;
}

function rotateLeft32(value: number, shift: number): number {
    const normalizedShift = shift & 31;
    const normalizedValue = value >>> 0;

    return normalizedShift === 0
        ? normalizedValue
        : ((normalizedValue << normalizedShift) |
              (normalizedValue >>> (32 - normalizedShift))) >>>
              0;
}

function hash32(value: number): number {
    let hashed = u32(value);
    hashed ^= hashed >>> 16;
    hashed = multiply32(hashed, 2246822507);
    hashed ^= hashed >>> 13;
    hashed = multiply32(hashed, 3266489909);
    hashed ^= hashed >>> 16;
    return u32(hashed);
}

function fnv1a(value: string): number {
    let hash = 2166136261;

    for (let index = 0; index < value.length; index++) {
        hash = multiply32(hash ^ value.charCodeAt(index), 16777619);
    }

    return hash32(hash);
}

function initializeStream(seed: string, secondKey: string): StreamState {
    const stream: Array<number | undefined> = new Array(61);
    let value = u32(
        hash32(
            fnv1a(seed) ^ hash32(u32((Number(secondKey) >>> 0) ^ 2654435769))
        )
    );

    for (let index = 0; index < 8; index++) {
        const streamIndex = value % 61;
        value = rotateLeft32(value + 2654435769, 7 + (7 & index));
        stream[streamIndex] = u32(value ^ hash32(value));
        value = hash32(u32(value + streamIndex));
    }

    return {
        stream,
        accumulator: u32(hash32(2779096485 ^ value))
    };
}

function nextWord(state: StreamState, counter: number): number {
    const index = state.accumulator % 61;
    const currentValue = state.stream[index] ?? 0;
    const existingValueMask = 0 - Number(index in state.stream);
    const mixed = u32(currentValue ^ multiply32(2654435769, counter + 1));
    const combined = u32(
        (state.accumulator ^ mixed) |
            (state.accumulator & mixed & existingValueMask)
    );
    const next = hash32(
        u32(
            rotateLeft32(u32(combined + state.accumulator), index) ^
                rotateLeft32(state.accumulator, Math.imul(index, 7))
        ) + 2654435769
    );

    state.stream[index] = next;
    state.accumulator = next;
    return next;
}

function createKeystream(
    seed: string,
    secondKey: string,
    length: number
): Uint8Array {
    const state = initializeStream(seed, secondKey);
    const bytes = new Uint8Array(length);
    let counter = 0;

    for (let index = 0; index < length; ) {
        const word = nextWord(state, counter++);
        bytes[index++] = word & 255;
        if (index < length) bytes[index++] = (word >>> 8) & 255;
        if (index < length) bytes[index++] = (word >>> 16) & 255;
        if (index < length) bytes[index++] = (word >>> 24) & 255;
    }

    return bytes;
}

/** Decrypt a seed-bound URL-safe Base64 Videasy API response locally. */
export function decryptResponse(
    encryptedPayload: string,
    seed: string,
    mediaId: string
): VideasyDecryptedPayload | null {
    if (!encryptedPayload || !seed) return null;

    try {
        const base64 = encryptedPayload
            .trim()
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        const padding = '='.repeat((4 - (base64.length % 4)) % 4);
        const data = Buffer.from(`${base64}${padding}`, 'base64');
        const keyStream = createKeystream(seed, mediaId, data.length);

        for (let index = 0; index < data.length; index++) {
            data[index] ^= keyStream[index];
        }

        if (
            data.length <= MAGIC.length ||
            MAGIC.some((value, index) => data[index] !== value)
        ) {
            return null;
        }

        return JSON.parse(
            data.subarray(MAGIC.length).toString('utf8')
        ) as VideasyDecryptedPayload;
    } catch {
        return null;
    }
}
