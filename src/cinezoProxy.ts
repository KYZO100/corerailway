import { ProxyService } from '@omss/framework';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const ALLOWED_HOST = 'proxy3.flikhub.net';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

type CinezoProxyQuery = { data?: string };

export function registerCinezoProxy(app: FastifyInstance): void {
    app.get(
        '/v1/cinezo-proxy',
        async (
            request: FastifyRequest<{ Querystring: CinezoProxyQuery }>,
            reply: FastifyReply
        ) => {
            try {
                if (!request.query.data) {
                    return reply.code(400).send({ error: 'Missing proxy data' });
                }
                const proxyData = ProxyService.decodeProxyData(request.query.data);
                const headers = safeHeaders(proxyData.headers);
                const validationUrl = new URL(proxyData.url);
                const carriedTarget = headers['X-Cinezo-Target'];
                delete headers['X-Cinezo-Target'];
                const target = new URL(carriedTarget || proxyData.url);
                const usesValidationUrl = Boolean(carriedTarget);
                if (
                    target.protocol !== 'https:' ||
                    target.hostname !== ALLOWED_HOST ||
                    (usesValidationUrl &&
                        (validationUrl.protocol !== 'https:' ||
                            validationUrl.hostname !== 'cinezo.live'))
                ) {
                    return reply
                        .code(403)
                        .send({ error: 'Upstream host is not allowed' });
                }

                if (request.headers.range) headers.Range = request.headers.range;
                const response = await fetch(target, {
                    headers,
                    signal: AbortSignal.timeout(30_000)
                });
                if (!response.ok) {
                    await response.body?.cancel();
                    return reply.code(response.status).send({
                        error: `Upstream returned ${response.status}`
                    });
                }

                const isManifest = target.pathname.endsWith('.mpd');
                const sizeLimit = isManifest
                    ? MAX_MANIFEST_BYTES
                    : MAX_SEGMENT_BYTES;
                const declaredLength = Number(
                    response.headers.get('content-length') ?? 0
                );
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
                              headers
                          ),
                          'utf8'
                      )
                    : bytes;

                reply
                    .code(response.status)
                    .type(
                        isManifest
                            ? 'application/dash+xml'
                            : (response.headers.get('content-type') ??
                                  'application/octet-stream')
                    );
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
                            : 'Cinezo proxy request failed'
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
    const baseMatch = content.match(/<BaseURL>([^<]+)<\/BaseURL>/i);
    const segmentBase = baseMatch
        ? new URL(baseMatch[1], manifestUrl)
        : manifestUrl;
    const rewrite = (rawUrl: string, baseUrl = manifestUrl): string => {
        if (/^(?:data:|urn:|#)/i.test(rawUrl)) return rawUrl;
        const resolvedUrl = new URL(rawUrl, baseUrl).toString();
        const data = encodeURIComponent(
            JSON.stringify({ url: resolvedUrl, headers })
        );
        return restoreDashTemplates(`/v1/cinezo-proxy?data=${data}`);
    };

    return content
        .replace(/<BaseURL>([^<]+)<\/BaseURL>/gi, (_match, rawUrl: string) => {
            return `<BaseURL>${rewrite(rawUrl)}</BaseURL>`;
        })
        .replace(
            /\b(initialization|media|sourceURL)=(['"])([^'"]+)\2/gi,
            (_match, attribute: string, quote: string, rawUrl: string) => {
                return `${attribute}=${quote}${rewrite(rawUrl, segmentBase)}${quote}`;
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