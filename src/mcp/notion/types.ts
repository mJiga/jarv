// src/mcp/notion/types.ts
// Type definitions for Notion API responses.
// Reduces `any` usage by providing typed wrappers for the dataSources API
// which is not covered by the official @notionhq/client types.

import type { Client } from "@notionhq/client";

// -----------------------------------------------------------------------------
// Data Source API types (not in official SDK)
// -----------------------------------------------------------------------------

export interface data_source_query_params {
  data_source_id: string;
  filter?: Record<string, unknown> | undefined;
  sorts?: Array<Record<string, unknown>> | undefined;
  page_size?: number | undefined;
}

export interface notion_page {
  id: string;
  properties: Record<string, unknown>;
}

export interface data_source_query_response {
  results: notion_page[];
}

/** Typed wrapper for dataSources API calls */
interface data_sources_api {
  query(params: data_source_query_params): Promise<data_source_query_response>;
}

/**
 * Casts the Notion client to access the dataSources API.
 * Returns the client as-is plus a typed dataSources property.
 * Single escape hatch instead of scattered `as any` casts.
 */
type notion_client_with_typed_ds = Omit<Client, "dataSources"> & {
  dataSources: data_sources_api;
};

export function with_data_sources(client: Client): notion_client_with_typed_ds {
  return client as unknown as notion_client_with_typed_ds;
}

// -----------------------------------------------------------------------------
// Page property helpers
// -----------------------------------------------------------------------------

/** Safely extracts a number property value from a Notion page */
export function get_number_prop(props: Record<string, unknown>, key: string): number | null {
  const prop = props[key] as { number?: number | null } | undefined;
  return prop?.number ?? null;
}

/** Safely extracts rich_text content from a Notion page */
export function get_rich_text_prop(props: Record<string, unknown>, key: string): string {
  const prop = props[key] as { rich_text?: Array<{ text?: { content?: string }; plain_text?: string }> } | undefined;
  const first = prop?.rich_text?.[0];
  return first?.text?.content ?? first?.plain_text ?? "";
}

/** Safely extracts a relation array from a Notion page */
export function get_relation_prop(props: Record<string, unknown>, key: string): Array<{ id: string }> {
  const prop = props[key] as { relation?: Array<{ id: string }> } | undefined;
  return prop?.relation ?? [];
}

/** Safely extracts a formula number from a Notion page */
export function get_formula_number_prop(props: Record<string, unknown>, key: string): number | null {
  const prop = props[key] as { formula?: { number?: number | null } } | undefined;
  return prop?.formula?.number ?? null;
}

/** Safely extracts a checkbox value from a Notion page */
export function get_checkbox_prop(props: Record<string, unknown>, key: string): boolean {
  const prop = props[key] as { checkbox?: boolean } | undefined;
  return prop?.checkbox ?? false;
}

/** Safely extracts a date start string from a Notion page */
export function get_date_prop(props: Record<string, unknown>, key: string): string {
  const prop = props[key] as { date?: { start?: string } | null } | undefined;
  return prop?.date?.start ?? "";
}

/** Safely extracts title text from a Notion page */
export function get_title_text(page: notion_page): string {
  const props = page.properties;
  const title_prop = props["title"] as { title?: Array<{ plain_text?: string }> } | undefined;
  const title_arr = title_prop?.title;
  if (!Array.isArray(title_arr) || title_arr.length === 0) return "";
  return title_arr[0]?.plain_text ?? "";
}

// -----------------------------------------------------------------------------
// Error helpers
// -----------------------------------------------------------------------------

/**
 * Checks if an error is a Notion API validation error.
 * Used to distinguish schema mismatches (e.g., "categories" vs "category"
 * property name) from transient errors like network failures or rate limits.
 */
export function is_notion_validation_error(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code: string }).code === "validation_error";
  }
  return false;
}
