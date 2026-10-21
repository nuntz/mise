# One validated tool entry point; change notices instead of SDK state

The household Durable Object is an Agents SDK `Agent`. It exposes the tool registry through a single `callTool(name, input)` callable that validates input against the tool's schema, rather than one `@callable` per tool. Domain data lives in our own SQLite tables. Connected clients receive only small change notices (what changed, new revision) and refetch through tools. We don't use the SDK's broadcast state document for domain data.

The PWA, the Drop 2 Pi agent and any future coordinator therefore see the same data through the same validated path, and the registry stays the one list of what Mise can do. The SDK's single-blob state would duplicate the database and give the UI a second source of truth.
