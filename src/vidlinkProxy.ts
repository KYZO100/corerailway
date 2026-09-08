import { ProxyService } from '@omss/framework';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const ALLOWED_HOST = 'sacdn.hakunaymatata.com';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

type VidLinkProxyQuery = { data?: string };

export function registerVidLinkProxy(app: FastifyInstance): void {
    app.get(
        '/v1/vidlink-proxy',
        async (
            request: FastifyRequest<{ Querystring: VidLinkProxyQuery }>,
            reply: FastifyReply
        ) => {
            try {
                if (!request.query.data) {
                    return reply
                        .code(400)
                        .send({ error: 'Missing proxy data' });
                }
                const proxyData = ProxyService.decodeProxyData(
                    request.query.data
                );
                const target = new URL(proxyData.url);
                if (
                    target.protocol !== 'https:' ||
                    target.hostname !== ALLOWED_HOST
                ) {
                    return reply
                        .code(403)
                        .send({ error: 'Upstream host is not allowed' });
                }

                const headers = safeHeaders(proxyData.headers);
                if (request.headers.range)
                    headers.Range = request.headers.range;
                const response = await fetch(target, {
                    headers,
                    signal: AbortSignal.timeout(30_000)
                });
                if (!response.ok) {
                    await response.body?.cancel();
                    return reply
                        .code(response.status)
                        .send({
                            error: `Upstream returned ${response.status}`
                        });
                }

                const contentType = target.pathname.endsWith('.mpd')
                    ? 'application/dash+xml'
                    : (response.headers.get('content-type') ??
                      'application/octet-stream');
                const declaredLength = Number(
                    response.headers.get('content-length') ?? 0
                );
                const isManifest = target.pathname.endsWith('.mpd');
                const sizeLimit = isManifest
                    ? MAX_MANIFEST_BYTES
                    : MAX_SEGMENT_BYTES;
                if (declaredLength > sizeLimit) {
                    await response.body?.cancel();
                    return reply
                        .code(413)
                        .send({ error: 'Upstream response is too large' });
                }

                const bytes = Buffer.from(await response.arrayBuffer());
                if (bytes.length > sizeLimit) {
                    return reply
                        .code(413)
                        .send({ error: 'Upstream response is too large' });
                }
                const body = isManifest
                    ? Buffer.from(
                          rewriteDashManifest(
                              bytes.toString('utf8'),
                              target,
                              proxyData.headers
                          ),
                          'utf8'
                      )
                    : bytes;

                reply.code(response.status).type(contentType);
                for (const name of [
                    'accept-ranges',
                    'cache-control',
                    'content-range',
                    'etag',
                    'last-modified'
                ]) {
                    const value = response.headers.get(name);
                    if (value) reply.header(name, value);
                }
                return reply.header('content-length', body.length).send(body);
            } catch (error) {
                return reply.code(502).send({
                    error:
                        error instanceof Error
                            ? error.message
                            : 'VidLink proxy request failed'
                });
            }
        }
    );
}

function rewriteDashManifest(
    content: string,
    manifestUrl: URL,
    headers?: Record<string, string>
): string {
    return content.replace(
        /\b(initialization|media|sourceURL)=(['"])([^'"]+)\2/gi,
        (match, attribute: string, quote: string, rawUrl: string) => {
            if (/^(?:data:|urn:|#)/i.test(rawUrl)) return match;
            const resolvedUrl = new URL(rawUrl, manifestUrl).toString();
            const data = encodeURIComponent(
                JSON.stringify({ url: resolvedUrl, headers })
            );
            const proxyUrl = restoreDashTemplates(
                `/v1/vidlink-proxy?data=${data}`
            );
            return `${attribute}=${quote}${proxyUrl}${quote}`;
        }
    );
}

function restoreDashTemplates(url: string): string {
    return url.replace(
        /%24(RepresentationID|Number|Bandwidth|Time)(%25\d+d)?%24/gi,
        (_template, name: string, format = '') =>
            `$${name}${format.replace(/^%25/i, '%')}$`
    );
}

function safeHeaders(value?: Record<string, string>): Record<string, string> {
    if (!value) return {};
    const headers: Record<string, string> = {};
    for (const [name, headerValue] of Object.entries(value)) {
        if (!/[\0\r\n]/.test(name + headerValue)) headers[name] = headerValue;
    }
    return headers;
}
