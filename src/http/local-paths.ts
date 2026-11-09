/**
 * Remote (HTTP) mode must never let a caller choose a path on the host: no
 * writes (downloads, exports, thumbnails) and no reads (uploads, attachments,
 * which could exfiltrate host files such as the token store).
 * Every argument that names a local file or directory is listed here; a test
 * fails when a tool schema grows a path-like argument missing from this list.
 */
export const LOCAL_PATH_ARGS = ["destination_path", "source_path", "file_path", "dest_dir", "attachment_paths"] as const;

function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** A refusal message when the call names a local path, else undefined. Pure. */
export function localPathRefusal(tool: string, args: Record<string, unknown> | undefined): string | undefined {
  const used = LOCAL_PATH_ARGS.filter((k) => present(args?.[k]));
  if (used.length === 0) return undefined;
  return (
    `Refused: ${tool} reads or writes a file on the server's disk (${used.join(", ")}), ` +
    `which the remote connector does not allow. Use the file's Drive link or metadata tools instead, ` +
    `or run this tool from the local (stdio) server.`
  );
}
