// @zendori/integrations — external service integrations.
// Phase 6: a pure, injected-fetch HubSpot client (Private-App token, one-way
// ticket sync). Every function takes a HubSpotConfig { token, baseUrl?,
// fetchImpl? } as its first argument; the token only ever travels in the
// Authorization header and is never logged or returned.
export * from './hubspot/schemas.js';
export * from './hubspot/client.js';
export * from './hubspot/contacts.js';
export * from './hubspot/tickets.js';
export * from './hubspot/notes.js';
export * from './hubspot/properties.js';
export * from './hubspot/account.js';
// Phase 13: generic client for an org's own end systems (data actions, events).
export * from './custom-api/client.js';
// Phase 14a: minimal MCP client (Streamable HTTP) for an org's own MCP server.
export * from './mcp/client.js';
