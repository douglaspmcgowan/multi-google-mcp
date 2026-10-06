/** The shape every registered tool has. `readOnly` is required: a tool cannot be left unmarked. */
export interface ToolDef {
  name: string;
  description: string;
  /**
   * true: only reads data. false: creates, changes, sends, shares, trashes, or
   * writes a file to disk. Read-only mode (MULTI_GOOGLE_READ_ONLY) drops every
   * tool where this is false from the tool list.
   */
  readOnly: boolean;
  inputSchema: any;
  handler: (args: any) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}

/** The one place read-only mode is applied: write tools are removed, not refused. */
export function filterTools<T extends { readOnly: boolean }>(tools: readonly T[], readOnlyMode: boolean): T[] {
  return readOnlyMode ? tools.filter((t) => t.readOnly === true) : [...tools];
}
