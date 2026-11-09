import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HTTP_PORT, resolveHttpSettings } from "../src/http/start.js";

test("connector reads only MULTI_GOOGLE_* port and URL; generic PORT / PUBLIC_BASE_URL are ignored", () => {
  assert.equal(DEFAULT_HTTP_PORT, 47887);
  const generic = { PORT: "8787", PUBLIC_BASE_URL: "https://elsewhere.example" };
  assert.throws(() => resolveHttpSettings(generic), /MULTI_GOOGLE_PUBLIC_BASE_URL is not set/);
  assert.deepEqual(resolveHttpSettings({ ...generic, MULTI_GOOGLE_PUBLIC_BASE_URL: "https://h.ts.net" }), { port: 47887, publicBaseUrl: "https://h.ts.net" });
  assert.equal(resolveHttpSettings({ MULTI_GOOGLE_PUBLIC_BASE_URL: "https://h", MULTI_GOOGLE_PORT: "50001" }).port, 50001);
  for (const bad of ["0", "70000", "abc", "1.5"]) {
    assert.throws(() => resolveHttpSettings({ MULTI_GOOGLE_PUBLIC_BASE_URL: "https://h", MULTI_GOOGLE_PORT: bad }), /MULTI_GOOGLE_PORT/);
  }
});
