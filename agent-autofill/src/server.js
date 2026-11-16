// MCP server exposed to AI agents. Tool results never contain secret values.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fillLogin, listLogins, requestAuthorization } from './core.js';

const server = new McpServer({ name: 'agent-autofill', version: '0.1.0' });

const ok = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String(e?.message || e) }] });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

server.registerTool('list_logins', {
  title: 'List vault logins',
  description:
    "List the vault logins this tool can fill and the sites the user has approved each one for. Returns names and sites only, never usernames, passwords or codes.",
  inputSchema: {},
}, wrap(() => listLogins()));

server.registerTool('request_authorization', {
  title: 'Ask the user to approve a login for a site',
  description:
    "Ask the user to approve using a vault login on one or more sites. A dialog appears on the user's screen; their answer is saved to their allow-list. Only the user can approve: you cannot answer the dialog, and the result tells you what they chose. " +
    'Origins are exact (https://app.example.com) or wildcards: "https://*.example.com", "http://localhost:*", "https://*", or "*" for any site. login "*" asks for every login in the vault scope. Request the narrowest scope that does the job. If denied, do not ask again unless the user tells you to.',
  inputSchema: {
    login: z.string().describe('Login name or id from list_logins, or "*" for all'),
    origins: z.array(z.string()).min(1).describe('Sites to approve (origin, URL or wildcard pattern)'),
    allow_submit: z.boolean().optional().describe('Allow fill_login to submit the form (default true)'),
    reason: z.string().optional().describe('Short reason shown to the user'),
    vault: z.string().optional().describe('Vault name if more than one is configured'),
  },
}, wrap((a) => requestAuthorization(a)));

const selector = z.string().describe('CSS selector, XPath (starts with / or "xpath="), or "auto" to detect');
server.registerTool('fill_login', {
  title: 'Fill a login form from the vault',
  description:
    "Fill a sign-in form with a login the user approved for this site. The tool reads the secret from the vault and types it into the page itself; you only get back which fields were filled. It checks the page's real origin with the browser and refuses if the login is not approved there (then use request_authorization). " +
    "target.type 'chrome' = the user's Chrome through the Agent Autofill extension (tab_id from your browser tool, or url_contains, default the active tab); 'cdp' = a Chromium started by automation, at a local DevTools endpoint such as http://127.0.0.1:9222. " +
    'fields defaults to username + password, auto-detected. For a one-time-code page pass only { "totp": "auto" }. Passwords only go into password-type inputs.',
  inputSchema: {
    login: z.string().describe('Login name or id from list_logins'),
    target: z.discriminatedUnion('type', [
      z.object({ type: z.literal('chrome'), tab_id: z.number().int().optional(), url_contains: z.string().optional() }),
      z.object({ type: z.literal('cdp'), endpoint: z.string(), target_id: z.string().optional(), url_contains: z.string().optional() }),
    ]),
    fields: z.object({ username: selector.optional(), password: selector.optional(), totp: selector.optional() }).optional(),
    submit: z.union([z.boolean(), z.string()]).optional().describe('true = submit the form, or a selector of the button to click'),
    vault: z.string().optional(),
  },
}, wrap((a) => fillLogin(a)));

await server.connect(new StdioServerTransport());
