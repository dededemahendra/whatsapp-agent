import type { CallToolResult } from '@modelcontextprotocol/server';

export function ok(structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
}

export function effectiveLimit(requested: number | undefined, fallback: number, maxResults: number): number {
  return Math.min(requested ?? fallback, maxResults, 200);
}
