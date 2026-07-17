/** JSON Schema subset used by WebMCP tool declarations. */
export interface McpJsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  properties?: Readonly<Record<string, McpJsonSchema>>;
  items?: McpJsonSchema;
  required?: readonly string[];
  enum?: readonly (string | number | boolean | null)[];
  additionalProperties?: boolean | McpJsonSchema;
  minimum?: number;
  maximum?: number;
  [keyword: string]: unknown;
}

export interface McpToolInputSchema extends McpJsonSchema {
  type: 'object';
  properties: Readonly<Record<string, McpJsonSchema>>;
}

export type McpToolArguments = Readonly<Record<string, unknown>>;
export type McpToolHandler = (arguments_: McpToolArguments) => unknown | Promise<unknown>;

/**
 * Small capability boundary shared by tool registrars and WebMCP transports.
 * Tool modules should depend on this interface, never on a transport/widget.
 */
export interface McpToolHost {
  registerTool(name: string, description: string, inputSchema: McpToolInputSchema, handler: McpToolHandler): void;
}
