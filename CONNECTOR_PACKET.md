# KOSMU connector packet for Hermes

Give Hermes this package plus one token from KOSMU Settings.

## What the human does in KOSMU

1. Open KOSMU Settings -> Integrations.
2. Create or select the Hermes agent.
3. Grant Hermes access to the exact projects it may use.
4. Generate a token for Hermes.

That token is the only secret Hermes needs. Project permissions stay in KOSMU.

## What Hermes installs on the VPS

Copy `hermes-kosmu-tools-1.0.0.tgz` to the VPS, then run:

```bash
npm install ./hermes-kosmu-tools-1.0.0.tgz
```

Set environment:

```bash
export KOSMU_API_BASE_URL=https://kosmu.vercel.app
export KOSMU_AGENT_TOKEN=the-token-from-kosmu-settings
```

Check connection:

```bash
npx hermes-kosmu-doctor
```

Expected:

```text
Connection OK.
Visible projects: ...
```

## Tool registration

If Hermes can import JavaScript tools:

```js
import kosmuHermesTools from "hermes-kosmu-tools";

for (const tool of kosmuHermesTools) {
  hermes.registerTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    run: tool.execute,
  });
}
```

If Hermes can only run shell commands:

```bash
npx hermes-kosmu-call kosmu_search_projects '{"query":"email"}'
```

The full model-facing tool schemas are available at:

```js
import toolSchemas from "hermes-kosmu-tools/tools.json";
```

## Contract

Hermes should not use Dario's login. Hermes should use `KOSMU_AGENT_TOKEN`.
KOSMU decides what Hermes can access through project collaboration permissions.
