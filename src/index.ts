#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { loadConfig } from "./config.js";
import { NueipClient, NueipError } from "./client.js";
import { tools, type ToolContext } from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new NueipClient({
    companyCode: config.companyCode,
    employeeId: config.employeeId,
    password: config.password,
  });
  const ctx: ToolContext = { client, presets: config.presets };

  const server = new Server(
    { name: "nueip-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema, { target: "openApi3" }),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const tool = tools.find(t => t.name === req.params.name);
    if (!tool) throw new Error(`unknown tool: ${req.params.name}`);
    const input = tool.schema.parse(req.params.arguments ?? {});
    try {
      const result = await tool.handler(input, ctx);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      if (err instanceof NueipError) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `nueip rejected the request: ${err.message}\n\nRaw response: ${JSON.stringify(err.raw, null, 2)}`,
          }],
        };
      }
      throw err;
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error("nueip-mcp fatal:", err);
  process.exit(1);
});
