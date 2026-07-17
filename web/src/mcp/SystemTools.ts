import type { McpToolHost } from './McpToolHost';

export function registerSystemTools(mcp: McpToolHost) {
  mcp.registerTool(
    'get_system_info',
    'Get general system status and version info for OrcaXR Web.',
    { type: 'object', properties: {}, additionalProperties: false },
    async function () {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                app: 'OrcaXR Web',
                version: '0.1.0',
                platform: navigator.userAgent,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
