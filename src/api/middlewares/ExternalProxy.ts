import { Config, extractVideoFrame, fetchPublicUrl, reserveVideoFrame, verifyExternalPath } from "@spacebar/util";
import { Request, Response } from "express";

const MAX_SIZE = 50 * 1024 * 1024;
const MAX_RANGE_SIZE = 8 * 1024 * 1024;
const PASSTHROUGH_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"];

let active = 0;

export async function ExternalProxy(req: Request, res: Response) {
    if (active >= 32) return res.status(503).send("Media proxy is busy");
    active++;
    try {
        return await serveExternalProxy(req, res);
    } finally {
        active--;
    }
}

// What comes back is served from this origin, so nothing that can carry script:
// image/svg+xml opened on its own runs its <script> here, next to the client's token.
// The same list and policy the CDN uses for uploads (cdn/util/responseSafety.ts).
const PROXIED_MEDIA_TYPE = /^(image\/(png|jpeg|gif|webp|avif|apng|bmp|x-icon|vnd\.microsoft\.icon)|video\/[\w.+-]+|audio\/[\w.+-]+)(;|$)/i;
const PROXIED_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; frame-ancestors 'none'";

const boundedRange = (header: string | undefined) => {
    if (!header) return undefined;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match || (!match[1] && !match[2])) return header;
    if (!match[1]) {
        const suffix = Number(match[2]);
        return Number.isSafeInteger(suffix) && suffix > 0 ? `bytes=-${Math.min(suffix, MAX_RANGE_SIZE)}` : header;
    }
    const start = Number(match[1]);
    if (!Number.isSafeInteger(start) || start < 0) return header;
    const maxEnd = start + MAX_RANGE_SIZE - 1;
    if (!match[2]) return `bytes=${start}-${maxEnd}`;
    const end = Number(match[2]);
    if (!Number.isSafeInteger(end) || end < start) return header;
    return `bytes=${start}-${Math.min(end, maxEnd)}`;
};

async function serveExternalProxy(req: Request, res: Response) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", PROXIED_CONTENT_SECURITY_POLICY);
    const [, , hash, ...rest] = req.originalUrl.split("?")[0].split("/");
    const path = rest.join("/");
    if (!hash || !verifyExternalPath(hash, path)) return res.status(403).send("Invalid signature");

    const search = rest[0]?.startsWith("%3F") ? decodeURIComponent(rest.shift()!) : "";
    const [protocol, ...location] = rest;
    if (protocol !== "https" && protocol !== "http") return res.status(400).send("Invalid protocol");

    let target: string;
    try {
        const mediaUrl = new URL(`${protocol}://${location.join("/")}${search}`);
        if (mediaUrl.username || mediaUrl.password) return res.status(400).send("Media URL credentials are not allowed");
        target = mediaUrl.href;
    } catch {
        return res.status(400).send("Invalid media URL");
    }
    if (req.query.format) {
        const head = await fetchPublicUrl(target, { method: "HEAD", redirect: "follow" }, 3, { timeoutMs: 10000 }).catch(() => null);
        if (head?.headers.get("content-type")?.startsWith("video/")) {
            const release = reserveVideoFrame();
            if (!release) return res.status(503).setHeader("retry-after", "1").send("Preview capacity is busy");
            const frame = await fetchPublicUrl(target, { redirect: "follow" }, 3, { maxBytes: MAX_SIZE, timeoutMs: 15000 })
                .then(async (video) => (video.ok ? extractVideoFrame(Buffer.from(await video.arrayBuffer()), undefined, true) : null))
                .catch(() => null)
                .finally(release);
            if (!frame) return res.status(415).send("Unable to render a preview frame");
            res.setHeader("content-type", "image/jpeg");
            res.setHeader("cache-control", `public, max-age=${Config.get().cdn.proxyCacheHeaderSeconds}`);
            res.setHeader("access-control-allow-origin", "*");
            res.setHeader("cross-origin-resource-policy", "cross-origin");
            return res.send(frame);
        }
    }

    const abort = new AbortController();
    const disconnected = () => {
        if (!res.writableEnded) abort.abort();
    };
    res.once("close", disconnected);
    try {
        const upstream = await fetchPublicUrl(
            target,
            {
                redirect: "follow",
                headers: {
                    "user-agent": Config.get().embeds.defaultUserAgent ?? "Mozilla/5.0",
                    ...(req.headers.range && { range: boundedRange(req.headers.range) }),
                },
                signal: abort.signal,
            },
            3,
            { maxBytes: MAX_SIZE, timeoutMs: 15000 },
        );
        if (!upstream.ok) return res.status(upstream.status).send(`Media proxy responded with ${upstream.status}`);
        const type = upstream.headers.get("content-type") ?? "";
        if (!PROXIED_MEDIA_TYPE.test(type)) return res.status(415).send("Unsupported media type");
        const body = Buffer.from(await upstream.arrayBuffer());
        res.status(upstream.status);
        for (const header of PASSTHROUGH_HEADERS) {
            const value = upstream.headers.get(header);
            if (value) res.setHeader(header, value);
        }
        res.setHeader("content-length", String(body.length));
        if (upstream.headers.get("content-range")) res.setHeader("accept-ranges", "bytes");
        res.setHeader("cache-control", `public, max-age=${Config.get().cdn.proxyCacheHeaderSeconds}`);
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("cross-origin-resource-policy", "cross-origin");
        res.end(body);
    } catch (error) {
        if (res.headersSent) res.destroy();
        else if (/byte limit/.test(String(error))) res.status(413).send("Media response too large");
        else res.status(502).send("Unable to reach media proxy");
    } finally {
        res.off("close", disconnected);
    }
}
