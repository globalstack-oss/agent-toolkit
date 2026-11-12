import { z } from 'zod';
import type { ApiCall, ScopedClient } from '../api/client';

/** Sets the default permission: read = allow, setup = ask in chat, money = ask a person (hosted page for merchants; local pop-up for internal tests). */
export type ToolGroup = 'read' | 'setup' | 'money';

export interface Summary {
  title: string;
  lines: Array<[string, string]>;
  warning?: string;
}

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  group: ToolGroup;
  /** Every API call this tool may make. Anything else is blocked before it leaves the machine. */
  calls: readonly ApiCall[];
  inputSchema: Shape;
  run(args: z.infer<z.ZodObject<Shape>>, api: ScopedClient): Promise<unknown>;
  /**
   * Plain-language summary for the approval prompt. Write tools should always provide one.
   * It may read (GET) through `api`, e.g. to show a quote's amounts.
   */
  describe?(args: z.infer<z.ZodObject<Shape>>, api: ScopedClient): Summary | Promise<Summary>;
  /** Runs before the approval prompt. A non-null result stops the call without asking the human. */
  precheck?(args: z.infer<z.ZodObject<Shape>>, api: ScopedClient): Promise<Record<string, unknown> | null>;
  /** The payment's value in USD, for the per-payment cap. Null when it cannot be priced. */
  amountUsd?(args: z.infer<z.ZodObject<Shape>>, api: ScopedClient): number | null | Promise<number | null>;
}

export function defineTool<Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>): ToolDefinition {
  return tool as unknown as ToolDefinition;
}
