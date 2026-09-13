import { test } from "node:test";
import assert from "node:assert/strict";
import { Http1RequestParser, serializeRequest, headerValue } from "../gateway/lib/http1.mjs";

test("parses a Content-Length request and preserves headers", () => {
	const raw = Buffer.from("POST /v1/messages?beta=true HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Length: 5\r\nX-Claude-Code-Session-Id: abc\r\n\r\nhello", "latin1");
	const parser = new Http1RequestParser();
	const requests = parser.push(raw);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].method, "POST");
	assert.equal(requests[0].target, "/v1/messages?beta=true");
	assert.equal(requests[0].body.toString(), "hello");
	assert.equal(headerValue(requests[0], "x-claude-code-session-id"), "abc");
	assert.equal(parser.isBroken, false);
});

test("returns nothing until the body is complete, then frames both requests", () => {
	const parser = new Http1RequestParser();
	assert.equal(parser.push(Buffer.from("GET /a HTTP/1.1\r\nHost: h\r\n\r\n", "latin1")).length, 1);
	const combined = "POST /b HTTP/1.1\r\nHost: h\r\nContent-Length: 3\r\n\r\nabc";
	assert.equal(parser.push(Buffer.from(combined.slice(0, 20), "latin1")).length, 0);
	const rest = parser.push(Buffer.from(combined.slice(20), "latin1"));
	assert.equal(rest.length, 1);
	assert.equal(rest[0].body.toString(), "abc");
});

test("serializeRequest rewrites Content-Length", () => {
	const parser = new Http1RequestParser();
	const [req] = parser.push(Buffer.from("POST /v1/messages HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\n\r\nhello", "latin1"));
	const out = serializeRequest(req, Buffer.from("hello world", "utf8"));
	assert.match(out.toString("latin1"), /Content-Length: 11/);
	assert.ok(out.toString("latin1").endsWith("hello world"));
});

test("chunked requests are surfaced as unframeable bodies", () => {
	const parser = new Http1RequestParser();
	const raw = Buffer.from("POST /v1/messages HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n", "latin1");
	const [req] = parser.push(raw);
	assert.equal(req.chunked, true);
	assert.equal(req.body, null);
});

test("takeRemaining loses no bytes on fallback", () => {
	const parser = new Http1RequestParser();
	parser.push(Buffer.from("POST /x HTTP/1.1\r\nContent-Length: 100\r\n\r\npartial", "latin1"));
	assert.equal(parser.takeRemaining().toString(), "POST /x HTTP/1.1\r\nContent-Length: 100\r\n\r\npartial");
});
