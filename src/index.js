#!/usr/bin/env node
// src/index.js
//
// MCP server entrypoint. Run over stdio so any MCP client can launch it:
//   node src/index.js  (or the `recordforge-mcp` bin once installed)
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RecordForge } from './engine.js';
import { createMcpServer } from './mcp-server.js';

const forge = new RecordForge();
const server = createMcpServer(forge);

const transport = new StdioServerTransport();
await server.connect(transport);
