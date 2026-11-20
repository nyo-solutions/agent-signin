// MCP server exposed to AI agents. Tool results never contain secret values.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fillLogin, fillSignup, listLogins, requestAuthorization } from './core.js';

const server = new McpServer({ name: 'agent-autofill', version: '0.1.0' });

const ok = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String(e?.message || e) }] });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

server.registerTool('list_logins', {
  title: 'List vault logins',
  description:
    "List the vault logins (for fill_login) and identities (for fill_signup), with the sites the user has approved each one for. Returns names, sites and which fields exist only, never usernames, passwords, codes or personal details.",
  inputSchema: {},
}, wrap(() => listLogins()));

server.registerTool('request_authorization', {
  title: 'Ask the user to approve a login for a site',
  description:
    "Ask the user to approve using a vault login (to sign in) or an identity (to sign up / create an account) on one or more sites. A dialog appears on the user's screen; their answer is saved to their allow-list. Only the user can approve: you cannot answer the dialog, and the result tells you what they chose. " +
    'Pass exactly one of login or identity. Origins are exact (https://app.example.com) or wildcards: "https://*.example.com", "http://localhost:*", "https://*", or "*" for any site. "*" as login or identity asks for all of them in the vault scope. Request the narrowest scope that does the job. If denied, do not ask again unless the user tells you to.',
  inputSchema: {
    login: z.string().optional().describe('Login name or id from list_logins, or "*" for all (to sign in)'),
    identity: z.string().optional().describe('Identity name or id from list_logins, or "*" for all (to sign up)'),
    origins: z.array(z.string()).min(1).describe('Sites to approve (origin, URL or wildcard pattern)'),
    allow_submit: z.boolean().optional().describe('Allow fill_login / fill_signup to submit the form (default true)'),
    allow_visible_secrets: z.boolean().optional().describe('Ask to let hidden custom fields (API keys, secrets) go into visible text inputs, for sites whose key boxes are plain text (default false)'),
    reason: z.string().optional().describe('Short reason shown to the user'),
    vault: z.string().optional().describe('Vault name if more than one is configured'),
  },
}, wrap((a) => requestAuthorization(a)));

const TARGET = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chrome'), tab_id: z.number().int().optional(), url_contains: z.string().optional(), profile: z.string().optional().describe('Chrome profile id from an earlier result, when several profiles are connected') }),
  z.object({ type: z.literal('cdp'), endpoint: z.string(), target_id: z.string().optional(), url_contains: z.string().optional() }),
]);
const selector = z.string().describe('CSS selector, XPath (starts with / or "xpath="), or "auto" to detect');
server.registerTool('fill_login', {
  title: 'Fill a login form from the vault',
  description:
    "Fill a sign-in form with a login the user approved for this site. The tool reads the secret from the vault and types it into the page itself; you only get back which fields were filled. It checks the page's real origin with the browser and refuses if the login is not approved there (then use request_authorization). " +
    "target.type 'chrome' = the user's Chrome through the Agent Autofill extension (tab_id from your browser tool, or url_contains, default the active tab; with several Chrome profiles the tool finds the profile that has the tab, and asks for target.profile only if it is ambiguous); 'cdp' = a Chromium started by automation, at a local DevTools endpoint such as http://127.0.0.1:9222. " +
    'fields defaults to username + password, auto-detected (or nothing, when only custom is given). For a one-time-code page pass only { "totp": "auto" }. ' +
    'custom fills the login\'s custom vault fields by name (list_logins shows names and types): text fields go into text inputs or textareas, boolean fields set checkboxes, hidden fields (API keys, secrets) only go into password-type inputs unless the user approved visible secrets for this site. Passwords only go into password-type inputs.',
  inputSchema: {
    login: z.string().describe('Login name or id from list_logins'),
    target: TARGET,
    fields: z.object({ username: selector.optional(), password: selector.optional(), totp: selector.optional() }).optional(),
    custom: z.record(z.string(), selector).optional().describe('Custom vault fields to fill: { "<field name from list_logins>": selector or "auto" } (e.g. API key, client secret, account id)'),
    submit: z.union([z.boolean(), z.string()]).optional().describe('true = submit the form, or a selector of the button to click'),
    vault: z.string().optional(),
  },
}, wrap((a) => fillLogin(a)));

const SIGNUP_FIELDS = ['first_name', 'last_name', 'full_name', 'email', 'username', 'phone', 'company', 'country', 'address1', 'address2', 'city', 'state', 'postal_code', 'password', 'password_confirm'];
server.registerTool('fill_signup', {
  title: 'Fill a sign-up form from a vault identity',
  description:
    "Fill a sign-up / registration form using an identity the user approved for this site. The tool types the identity's details (name, email, username, phone, company, address) and the account password into the page itself; you only get back which fields were filled and the name of the vault login holding the new password. " +
    'credentials "generate" (default) creates a strong password and saves it to the vault as a new login BEFORE filling, and approves that login for this site so you can sign in later with fill_login. credentials { login } reuses an existing vault login that is approved for this site. ' +
    "Without fields, everything the identity has is auto-detected and filled; fields the form lacks are listed as skipped. Pass fields (kind -> CSS / XPath / \"auto\") to target specific inputs. Never checks terms or consent boxes: that is the user's decision. Same target options as fill_login. Refuses unless the page's real origin is approved for signing up with this identity (use request_authorization with identity).",
  inputSchema: {
    identity: z.string().describe('Identity name or id from list_logins'),
    target: TARGET,
    credentials: z.union([z.literal('generate'), z.object({ login: z.string() })]).optional(),
    password_rules: z.object({
      length: z.number().int().min(12).max(128).optional(),
      digits: z.boolean().optional(),
      symbols: z.boolean().optional(),
      symbol_set: z.string().optional().describe('Allowed symbols if the site restricts them'),
    }).optional().describe('For generated passwords (default 20 chars, upper/lower/digits/symbols)'),
    login_name: z.string().optional().describe('Name for the new vault login (default: the site host)'),
    fields: z.object(Object.fromEntries(SIGNUP_FIELDS.map((f) => [f, selector.optional()]))).optional(),
    submit: z.union([z.boolean(), z.string()]).optional().describe('true = submit the form, or a selector of the button to click'),
    vault: z.string().optional(),
  },
}, wrap((a) => fillSignup(a)));

await server.connect(new StdioServerTransport());
