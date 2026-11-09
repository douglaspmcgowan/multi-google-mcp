/** HTTP (remote connector) mode with --http or MCP_TRANSPORT=http; stdio otherwise. Pure. */
export function wantsHttp(argv: string[], env: Record<string, string | undefined>): boolean {
  return argv.includes("--http") || (env.MCP_TRANSPORT ?? "").trim().toLowerCase() === "http";
}
