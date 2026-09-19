#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { emit, isMain, parseArgs, run } from '../../../lib/cli.mjs';
import { callMcpTool, listMcpTools, mcpStatus } from '../../../lib/services/mcp-client.mjs';

const USAGE = `algoria mcp — use registered Stellar8004 MCP services without x402

  tools <stellar8004:id:index>                    connect and list tool schemas
  call <stellar8004:id:index> --tool <name> --input <file> --approve [--id <UUID>]
  status <saved-call-id>                          local result; never repeats a call

Options: --json; --protocol 2025-11-25 (default) or 2026-07-28
Provider auth: --token-file <path> --auth-origin https://exact-provider-host
Streamable HTTP only, public HTTPS; no stdio commands or legacy SSE endpoints.
MCP does not imply free access. HTTP 401/403/402 stops; no wallet signing,
automatic purchases or automatic retries. Server tools may have side effects.
--approve represents existing authorization for this task, not payment approval.
Use the same --id after interruption, or status. Session/auth values are not saved.`;
/** @param {Record<string, string | boolean>} flags @param {string} key */
function value(flags, key) {
  if (typeof flags[key] !== 'string' || !flags[key]) throw new Error(`--${key} needs a value`);
  return /** @type {string} */ (flags[key]);
}
/** @param {string[]} argv */
export function main(argv) {
  return run(async () => {
    const { flags, positional } = parseArgs(argv);
    const [command, target] = positional;
    if (!command || command === 'help' || flags.help) { process.stdout.write(USAGE + '\n'); return; }
    const allowed = command === 'status' ? ['json'] : ['json', 'protocol', 'token-file', 'auth-origin', ...(command === 'call' ? ['tool', 'input', 'approve', 'id'] : [])];
    if (!['tools', 'call', 'status'].includes(command) || positional.length !== 2 || Object.keys(flags).some((f) => !allowed.includes(f))) throw new Error('invalid MCP command/options; use --help');
    const options = { ...(flags.protocol !== undefined ? { protocol: value(flags, 'protocol') } : {}),
      ...(flags['token-file'] !== undefined ? { tokenFile: value(flags, 'token-file') } : {}),
      ...(flags['auth-origin'] !== undefined ? { authOrigin: value(flags, 'auth-origin') } : {}) };
    let result;
    if (command === 'tools') result = await listMcpTools(target, options);
    else if (command === 'status') result = await mcpStatus(target);
    else {
      const input = await readFile(value(flags, 'input'), 'utf8');
      if (Buffer.byteLength(input) > 32768) throw new Error('input file exceeds 32768 bytes');
      result = await callMcpTool(target, value(flags, 'tool'), JSON.parse(input), { ...options, approve: flags.approve === true, ...(flags.id !== undefined ? { id: value(flags, 'id') } : {}) });
    }
    emit(flags, result, [JSON.stringify(result, null, 2)]);
  });
}
if (isMain(import.meta.url)) main(process.argv.slice(2));
