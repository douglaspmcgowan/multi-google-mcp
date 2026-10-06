import assert from "node:assert/strict";
import test from "node:test";
import { gmailTools } from "../src/tools/gmail.js";
import { calendarTools } from "../src/tools/calendar.js";
import { driveTools } from "../src/tools/drive.js";
import { docsTools } from "../src/tools/docs.js";
import { slidesTools } from "../src/tools/slides.js";
import { sheetsTools } from "../src/tools/sheets.js";
import { commentTools } from "../src/tools/comments.js";
import { chatTools } from "../src/tools/chat.js";
import { formsTools } from "../src/tools/forms.js";
import { tasksTools } from "../src/tools/tasks.js";
import { contactsTools } from "../src/tools/contacts.js";
import { meetTools } from "../src/tools/meet.js";
import { filterTools } from "../src/tools/types.js";
import { isReadOnlyMode } from "../src/config.js";

const all = [
  ...gmailTools,
  ...calendarTools,
  ...driveTools,
  ...docsTools,
  ...slidesTools,
  ...sheetsTools,
  ...commentTools,
  ...chatTools,
  ...formsTools,
  ...tasksTools,
  ...contactsTools,
  ...meetTools,
];

const EXPECTED_WRITES = [
  "gmail_send", "gmail_draft", "gmail_update_draft", "gmail_delete_draft", "gmail_download_attachment",
  "gmail_modify_labels", "gmail_archive", "gmail_mark_read",
  "gmail_trash", "gmail_untrash", "gmail_send_draft", "gmail_create_label", "gmail_update_label", "gmail_delete_label",
  "gmail_create_filter", "gmail_delete_filter", "gmail_set_vacation", "gmail_update_signature",
  "calendar_create_event", "calendar_update_event", "calendar_rsvp", "calendar_delete_event",
  "drive_download", "drive_export", "drive_share", "drive_unshare", "drive_create", "drive_update_content",
  "drive_upload", "drive_rename", "drive_move", "drive_copy", "drive_trash", "drive_untrash",
  "docs_add_comment", "docs_reply_comment", "docs_resolve_comment", "docs_add_tab", "docs_rename_tab",
  "docs_delete_tab", "docs_write_tab", "docs_write_markdown", "docs_append_to_tab", "docs_replace_text",
  "docs_batch_update", "sheets_write_range", "sheets_append_rows", "sheets_batch_update",
  "slides_replace_text", "slides_add_from_outline", "slides_batch_update",
  "chat_post_message", "chat_add_members", "chat_create_space", "chat_create_group_chat", "chat_find_or_create_dm",
  "chat_update_space", "chat_update_message", "chat_delete_message", "chat_upload_attachment", "chat_remove_member",
  "chat_update_member_role", "chat_add_reaction", "chat_remove_reaction", "forms_create",
  "tasks_create", "tasks_update", "tasks_complete",
  "tasks_delete", "tasks_move", "tasks_clear_completed", "tasks_create_list", "tasks_rename_list", "tasks_delete_list",
  "contacts_create", "contacts_update", "contacts_delete", "contacts_create_group", "contacts_add_to_group",
  "contacts_remove_from_group", "contacts_copy_other_to_my_contacts",
  "calendar_quick_add", "calendar_move_event", "calendar_create_calendar", "calendar_update_calendar",
  "calendar_delete_calendar", "calendar_share_calendar", "calendar_unshare_calendar",
  "meet_create_space", "meet_update_space", "meet_end_active_conference",
  "drive_download_revision", "drive_update_permission", "drive_transfer_ownership", "drive_set_link_sharing",
  "drive_star", "drive_update_metadata", "forms_add_questions", "forms_batch_update",
  "sheets_clear_range", "sheets_create", "sheets_add_tab", "sheets_rename_tab", "sheets_delete_tab",
  "slides_save_thumbnail", "slides_delete_slide", "slides_duplicate_slide", "slides_reorder_slides",
  "slides_insert_image", "slides_set_speaker_notes", "docs_reopen_comment", "docs_delete_comment",
];

test("every tool carries an explicit boolean readOnly flag", () => {
  assert.ok(all.length > 60);
  for (const t of all) assert.equal(typeof t.readOnly, "boolean", `${t.name} is unmarked`);
  const names = all.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool names");
});

test("read-only mode exposes zero write tools and keeps the read tools", () => {
  const exposed = filterTools(all, true);
  const names = new Set(exposed.map((t) => t.name));
  for (const w of EXPECTED_WRITES) {
    assert.ok(all.some((t) => t.name === w), `expected write tool ${w} is missing`);
    assert.ok(!names.has(w), `${w} must be absent in read-only mode`);
  }
  assert.ok(exposed.every((t) => t.readOnly === true));
  for (const r of ["gmail_search", "gmail_read_thread", "gmail_search_all", "gmail_list_drafts", "gmail_list_attachments", "calendar_freebusy", "tasks_list", "contacts_search", "drive_search"]) {
    assert.ok(names.has(r), `${r} should stay`);
  }
  // Every non-read tool is in the expected write list, so a new write tool cannot slip in unmarked.
  assert.deepEqual(
    all.filter((t) => !t.readOnly).map((t) => t.name).sort(),
    [...EXPECTED_WRITES].sort()
  );
});

test("outside read-only mode every tool is exposed", () => {
  assert.equal(filterTools(all, false).length, all.length);
});

test("MULTI_GOOGLE_READ_ONLY accepts 1 and true only", () => {
  assert.equal(isReadOnlyMode({ MULTI_GOOGLE_READ_ONLY: "1" }), true);
  assert.equal(isReadOnlyMode({ MULTI_GOOGLE_READ_ONLY: "true" }), true);
  assert.equal(isReadOnlyMode({ MULTI_GOOGLE_READ_ONLY: "TRUE" }), true);
  assert.equal(isReadOnlyMode({ MULTI_GOOGLE_READ_ONLY: "0" }), false);
  assert.equal(isReadOnlyMode({ MULTI_GOOGLE_READ_ONLY: "" }), false);
  assert.equal(isReadOnlyMode({}), false);
});
