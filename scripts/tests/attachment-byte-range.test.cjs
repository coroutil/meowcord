const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const ts = require("typescript");

function loadTypeScript(filename, mocks = {}) {
    const fixture = { exports: {} };
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    }).outputText;
    vm.runInNewContext(output, {
        module: fixture,
        exports: fixture.exports,
        require(name) {
            if (Object.hasOwn(mocks, name)) return mocks[name];
            return require(name);
        },
        process,
        Buffer,
        AbortSignal,
        AbortController,
        URL,
        Response,
        setTimeout,
        clearTimeout,
        console,
    });
    return fixture.exports;
}

test("filesystem storage serves only the requested byte range", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "meowcord-range-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const previousLocation = process.env.STORAGE_LOCATION;
    t.after(() => {
        if (previousLocation === undefined) delete process.env.STORAGE_LOCATION;
        else process.env.STORAGE_LOCATION = previousLocation;
    });
    process.env.STORAGE_LOCATION = root;
    fs.writeFileSync(path.join(root, "clip.mp4"), Buffer.from("0123456789"));

    class PassthroughExif {
        pipe(destination) {
            return destination;
        }
    }
    const { FileStorage } = loadTypeScript("src/cdn/util/FileStorage.ts", {
        "exif-be-gone": PassthroughExif,
    });
    const storage = new FileStorage();
    const read = await storage.openRead("clip.mp4", undefined, { start: 3, end: 6 });
    assert.ok(read);
    assert.equal(read.size, 10, "size remains the full object size");
    const chunks = [];
    for await (const chunk of read.stream) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), "3456");
    await assert.rejects(storage.openRead("clip.mp4", undefined, { start: 8, end: 12 }), /Invalid storage byte range/);
});


test("S3 storage sends Range upstream and retains the full object size", async () => {
    let request;
    class FakeS3 {
        async getObject(input) {
            request = input;
            return {
                Body: Readable.from(Buffer.from("2345")),
                ContentLength: 4,
                ContentRange: "bytes 2-5/10",
                Metadata: { generation: "fixture-generation" },
            };
        }
    }
    const { S3Storage } = loadTypeScript("src/cdn/util/S3Storage.ts", {
        "@aws-sdk/client-s3": { S3: FakeS3 },
    });
    const storage = new S3Storage("us-east-1", "fixture-bucket", "https://s3.example", true);
    const read = await storage.openRead("clip.mp4", undefined, { start: 2, end: 5 });
    assert.ok(read);
    assert.equal(request.Range, "bytes=2-5");
    assert.equal(read.size, 10);
    assert.equal(read.generation, "fixture-generation");
    const chunks = [];
    for await (const chunk of read.stream) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), "2345");
});


test("remote video embeds are routed through Meowcord's external media endpoint", () => {
    const crypto = require("node:crypto");
    const { proxyEmbedMedia } = loadTypeScript("src/util/util/MediaProxy.ts", {
        "node:crypto": crypto,
        "./Config": {
            Config: { get: () => ({ security: { requestSignature: "test-signing-key" }, cdn: { endpointPublic: "https://chat.example" } }) },
        },
        "@spacebar/schemas": {
            EmbedType: { rich: "rich" },
            MessageComponentType: { Container: 1, Section: 2, Thumbnail: 3, MediaGallery: 4, File: 5 },
        },
    });
    const transformed = proxyEmbedMedia({
        type: "rich",
        video: {
            url: "https://media.example/clip.mp4?token=fixture",
            proxy_url: "https://cors.estrogen.delivery/?url=old-proxy",
            content_type: "video/mp4",
            width: 640,
            height: 360,
        },
    });
    assert.match(transformed.video.url, /^https:\/\/chat\.example\/external\//);
    assert.equal(transformed.video.proxy_url, transformed.video.url);
});

test("external video proxy fetches the original URL and bounds open-ended ranges", async () => {
    let request;
    const { ExternalProxy } = loadTypeScript("src/api/middlewares/ExternalProxy.ts", {
        "@spacebar/util": {
            Config: { get: () => ({ embeds: { defaultUserAgent: "MeowcordTest/1.0" }, cdn: { proxyCacheHeaderSeconds: 60 } }) },
            extractVideoFrame: async () => null,
            fetchPublicUrl: async (url, init, redirects, limits) => {
                request = { url, init, redirects, limits };
                return new Response(Buffer.from("video bytes"), {
                    status: 206,
                    headers: {
                        "content-type": "video/mp4",
                        "content-range": "bytes 0-10/100",
                        "content-length": "11",
                    },
                });
            },
            reserveVideoFrame: () => () => {},
            verifyExternalPath: () => true,
        },
    });

    const headers = {};
    const result = { statusCode: 200, body: undefined, destroyed: false, writableEnded: false, headersSent: false };
    const res = {
        setHeader(name, value) {
            headers[name.toLowerCase()] = value;
            return this;
        },
        status(code) {
            result.statusCode = code;
            return this;
        },
        send(body) {
            result.body = body;
            result.writableEnded = true;
            return this;
        },
        end(body) {
            result.body = body;
            result.writableEnded = true;
            return this;
        },
        once() {
            return this;
        },
        off() {
            return this;
        },
        destroy() {
            result.destroyed = true;
        },
        get headersSent() {
            return result.headersSent;
        },
        get destroyed() {
            return result.destroyed;
        },
        get writableEnded() {
            return result.writableEnded;
        },
        get writableFinished() {
            return result.writableEnded;
        },
    };
    const req = {
        originalUrl: "/external/test-signature/https/media.example/video.mp4",
        headers: { range: "bytes=0-" },
        query: {},
    };

    await ExternalProxy(req, res);
    assert.ok(request, `proxy returned early: status=${result.statusCode}, body=${result.body}`);
    assert.equal(request.url, "https://media.example/video.mp4");
    assert.equal(request.init.redirect, "follow");
    assert.equal(request.init.headers.range, "bytes=0-8388607");
    assert.equal(request.redirects, 3);
    assert.equal(result.statusCode, 206);
    assert.equal(headers["content-range"], "bytes 0-10/100");
    assert.equal(headers["accept-ranges"], "bytes");
    assert.equal(result.body.toString(), "video bytes");
});
