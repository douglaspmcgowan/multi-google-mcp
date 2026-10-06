import assert from "node:assert/strict";
import test from "node:test";
import { createMeetTools, buildSpaceConfig, spaceName, MEET_CREATED_SCOPE } from "../src/tools/meet.js";
import { SCOPES } from "../src/config.js";
import { ScopeError } from "../src/scopes.js";

function build(lookup: (a: string) => string[] | undefined = () => undefined) {
  const calls: Record<string, any> = {};
  const space = { name: "spaces/abc", meetingUri: "https://meet.google.com/abc-mnop-xyz", meetingCode: "abc-mnop-xyz", config: { accessType: "TRUSTED" } };
  const client: any = {
    spaces: {
      create: async (r: any) => ((calls.create = r), { data: space }),
      get: async (r: any) => ((calls.get = r), { data: { ...space, activeConference: { conferenceRecord: "conferenceRecords/1" } } }),
      patch: async (r: any) => ((calls.patch = r), { data: space }),
      endActiveConference: async (r: any) => ((calls.end = r), { data: {} }),
    },
  };
  const tools = createMeetTools(() => client, () => ["me"], lookup);
  const call = async (name: string, args: any) => {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `missing ${name}`);
    return (await t.handler({ account: "me", ...args })).content[0].text;
  };
  return { calls, tools, call };
}

test("meet scope is requested at consent", () => {
  assert.ok(SCOPES.includes(MEET_CREATED_SCOPE));
});

test("spaceName normalizes ids, codes and full names", () => {
  assert.equal(spaceName("abc"), "spaces/abc");
  assert.equal(spaceName("spaces/abc"), "spaces/abc");
  assert.equal(spaceName("abc-mnop-xyz"), "spaces/abc-mnop-xyz");
  assert.throws(() => spaceName("  "), /space is required/);
});

test("buildSpaceConfig validates options and builds the update mask", () => {
  assert.deepEqual(buildSpaceConfig({}), { config: {}, mask: [] });
  assert.deepEqual(buildSpaceConfig({ access_type: "OPEN", entry_point_access: "CREATOR_APP_ONLY" }), {
    config: { accessType: "OPEN", entryPointAccess: "CREATOR_APP_ONLY" },
    mask: ["config.accessType", "config.entryPointAccess"],
  });
  assert.throws(() => buildSpaceConfig({ access_type: "PUBLIC" }), /Invalid access_type/);
  assert.throws(() => buildSpaceConfig({ entry_point_access: "x" }), /Invalid entry_point_access/);
});

test("meet_create_space returns URI and code, with and without access type", async () => {
  const { calls, call } = build();
  const out = JSON.parse(await call("meet_create_space", {}));
  assert.deepEqual(calls.create, { requestBody: {} });
  assert.equal(out.meeting_uri, "https://meet.google.com/abc-mnop-xyz");
  assert.equal(out.meeting_code, "abc-mnop-xyz");
  await call("meet_create_space", { access_type: "RESTRICTED" });
  assert.deepEqual(calls.create, { requestBody: { config: { accessType: "RESTRICTED" } } });
});

test("meet_get_space, update and end conference shape requests", async () => {
  const { calls, call } = build();
  const got = JSON.parse(await call("meet_get_space", { space: "abc-mnop-xyz" }));
  assert.equal(calls.get.name, "spaces/abc-mnop-xyz");
  assert.equal(got.active_conference, "conferenceRecords/1");
  await call("meet_update_space", { space: "spaces/abc", access_type: "OPEN" });
  assert.deepEqual(calls.patch, { name: "spaces/abc", updateMask: "config.accessType", requestBody: { config: { accessType: "OPEN" } } });
  await assert.rejects(() => call("meet_update_space", { space: "abc" }), /Nothing to update/);
  assert.match(await call("meet_end_active_conference", { space: "abc" }), /Ended/);
  assert.equal(calls.end.name, "spaces/abc");
});

test("readOnly flags and scope refusal", async () => {
  const { tools } = build();
  assert.deepEqual(
    tools.filter((t) => !/^meet_(list|get_conference)/.test(t.name)).map((t) => [t.name, t.readOnly]),
    [
      ["meet_create_space", false],
      ["meet_get_space", true],
      ["meet_update_space", false],
      ["meet_end_active_conference", false],
    ]
  );
  const refused = build(() => ["https://www.googleapis.com/auth/calendar"]);
  for (const t of refused.tools.filter((x) => !/^meet_(list|get_conference)/.test(x.name))) {
    await assert.rejects(() => t.handler({ account: "me", space: "abc", access_type: "OPEN" }), ScopeError);
  }
  const ok = build(() => [MEET_CREATED_SCOPE]);
  assert.ok(await ok.call("meet_get_space", { space: "abc" }));
});
