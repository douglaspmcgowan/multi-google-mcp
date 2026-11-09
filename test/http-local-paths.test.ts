import assert from "node:assert/strict";
import test from "node:test";
import { allTools } from "../src/server.js";
import { LOCAL_PATH_ARGS, localPathRefusal } from "../src/http/local-paths.js";

test("every path-like tool argument is in the remote refusal list", () => {
  const missing: string[] = [];
  for (const t of allTools) {
    for (const prop of Object.keys(t.inputSchema?.properties ?? {})) {
      if (/(_path|_paths|_dir|^path$|^dir$|directory|filename_on_disk)/i.test(prop) && !(LOCAL_PATH_ARGS as readonly string[]).includes(prop)) {
        missing.push(`${t.name}.${prop}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("refusal fires only when a local path is supplied", () => {
  assert.match(localPathRefusal("drive_download", { destination_path: "/tmp/x" })!, /Refused/);
  assert.match(localPathRefusal("gmail_send", { attachment_paths: ["/etc/passwd"] })!, /attachment_paths/);
  assert.equal(localPathRefusal("gmail_send", { attachment_paths: [] }), undefined);
  assert.equal(localPathRefusal("gmail_search", { query: "x" }), undefined);
});
