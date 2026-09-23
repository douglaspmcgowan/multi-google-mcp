import { z } from "zod";

/**
 * Converts a tool's JSON-Schema-style `inputSchema` into the Zod shape the MCP
 * SDK registers.
 *
 * This used to map every array to `z.array(z.string())` and every object to
 * `z.string()`, so the Docs, Slides and Sheets batch tools advertised their
 * request lists as arrays of strings and a client sending real request objects
 * was rejected. The conversion is now recursive: arrays keep their item type,
 * objects keep their properties (and pass unknown keys through, because raw
 * API requests carry fields no schema here lists), and an item a client sent
 * as a JSON string is parsed back into the object it encodes.
 */
export function jsonSchemaToZod(schema: any): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set<string>(schema?.required ?? []);
  for (const [key, prop] of Object.entries(schema?.properties ?? {}) as [string, any][]) {
    let zodType = propToZod(prop);
    if (!required.has(key)) zodType = zodType.optional();
    shape[key] = zodType;
  }
  return shape;
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function propToZod(prop: any): z.ZodTypeAny {
  const description = prop?.description ?? "";
  let zodType: z.ZodTypeAny;
  switch (prop?.type) {
    case "string":
      zodType = z.string();
      break;
    case "number":
    case "integer":
      zodType = z.number();
      break;
    case "boolean":
      zodType = z.boolean();
      break;
    case "array":
      zodType = z.preprocess(parseJsonString, z.array(prop.items ? propToZod(prop.items) : z.any()));
      break;
    case "object":
      zodType = z.preprocess(
        parseJsonString,
        prop.properties
          ? z.object(jsonSchemaToZod(prop)).passthrough()
          : z.record(z.string(), z.any())
      );
      break;
    default:
      zodType = z.any();
  }
  return description ? zodType.describe(description) : zodType;
}
