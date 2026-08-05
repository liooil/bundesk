import type { DesktopAppContext } from './app'

/**
 * One action, three layers:
 *
 * - CLI:  `my-app <name> --arg value ...`
 * - API:  `POST /api/actions/<name>` with a JSON body of named args
 * - GUI:  `GET /__bundesk/actions` renders a console that calls the API
 *
 * The handler runs once, in the application process, with full access to the
 * running server, window, updater, and single-instance state. Results must be
 * JSON-serializable (they travel over the loopback IPC server when a CLI
 * invocation is forwarded to a running primary instance).
 */

export type ActionArgumentType = 'string' | 'number' | 'boolean' | 'json'

export interface ActionArgumentSchema {
  name: string
  type: ActionArgumentType
  required?: boolean
  description?: string
  default?: unknown
}

export interface DesktopActionOptions<WebSocketData = undefined> {
  name: string
  description?: string
  args?: ActionArgumentSchema[]
  handler: (args: Record<string, unknown>, context: DesktopAppContext<WebSocketData>) => unknown | Promise<unknown>
}

export interface ActionDescriptor {
  name: string
  description?: string
  args: ActionArgumentSchema[]
}

export interface ActionRegistry {
  has(name: string): boolean
  list(): ActionDescriptor[]
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  /** Parse and run `--flag value` style argv; returns null when argv[0] is not an action. */
  callFromCli(argv: string[]): Promise<{ name: string; result: unknown } | null>
}

export const frameworkCommandNames = [
  'serve',
  'register',
  'unregister',
  'status',
  'upgrade',
  'install-service',
  'uninstall-service',
  'service-status',
] as const

export const actionsApiPath = '/api/actions'
export const actionsConsolePath = '/__bundesk/actions'

export class ActionNotFoundError extends Error {
  constructor(name: string) {
    super(`Unknown action: ${name}`)
    this.name = 'ActionNotFoundError'
  }
}

export class ActionArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActionArgumentError'
  }
}

export function createActionRegistry<WebSocketData = undefined>(
  actions: DesktopActionOptions<WebSocketData>[],
  getContext: () => DesktopAppContext<WebSocketData>,
): ActionRegistry {
  const byName = new Map<string, DesktopActionOptions<WebSocketData>>()

  for (const action of actions) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(action.name)) {
      throw new Error(`Invalid action name (use lowercase kebab-case): ${action.name}`)
    }
    if ((frameworkCommandNames as readonly string[]).includes(action.name)) {
      throw new Error(`Action name conflicts with a framework command: ${action.name}`)
    }
    if (byName.has(action.name)) {
      throw new Error(`Duplicate action: ${action.name}`)
    }
    for (const arg of action.args ?? []) {
      if (!/^[A-Za-z0-9_-]+$/.test(arg.name)) {
        throw new Error(`Invalid argument name in action ${action.name}: ${arg.name}`)
      }
    }
    byName.set(action.name, action)
  }

  const find = (name: string): DesktopActionOptions<WebSocketData> | undefined => byName.get(name)

  return {
    has: (name: string) => byName.has(name),
    list: () => [...byName.values()].map((action) => ({
      name: action.name,
      description: action.description,
      args: action.args ?? [],
    })),
    async call(name: string, rawArgs: Record<string, unknown> = {}) {
      const action = find(name)
      if (!action) throw new ActionNotFoundError(name)
      return action.handler(validateActionArgs(action.name, action.args ?? [], rawArgs), getContext())
    },
    async callFromCli(argv: string[]) {
      const name = argv[0]
      if (!name || !byName.has(name)) return null
      const action = find(name)!
      const args = parseActionCliArgs(action.name, action.args ?? [], argv.slice(1))
      return { name, result: await action.handler(args, getContext()) }
    },
  }
}

function validateActionArgs(
  actionName: string,
  schema: ActionArgumentSchema[],
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const arg of schema) {
    if (!Object.prototype.hasOwnProperty.call(raw, arg.name)) {
      if (arg.required) throw new ActionArgumentError(`Action ${actionName} requires argument: ${arg.name}`)
      if (arg.default !== undefined) result[arg.name] = arg.default
      continue
    }
    result[arg.name] = coerceArgument(actionName, arg, raw[arg.name])
  }
  const unknown = Object.keys(raw).filter((key) => !schema.some((arg) => arg.name === key))
  if (unknown.length > 0) {
    throw new ActionArgumentError(`Action ${actionName} received unknown argument(s): ${unknown.join(', ')}`)
  }
  return result
}

function coerceArgument(actionName: string, arg: ActionArgumentSchema, value: unknown): unknown {
  switch (arg.type) {
    case 'number': {
      const number = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(number)) throw new ActionArgumentError(`Action ${actionName}: ${arg.name} must be a number`)
      return number
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value
      if (value === 'true' || value === '1') return true
      if (value === 'false' || value === '0') return false
      throw new ActionArgumentError(`Action ${actionName}: ${arg.name} must be a boolean`)
    }
    case 'json': {
      if (typeof value === 'string') {
        try {
          return JSON.parse(value)
        } catch {
          throw new ActionArgumentError(`Action ${actionName}: ${arg.name} is not valid JSON`)
        }
      }
      return value
    }
    default:
      return value
  }
}

export function parseActionCliArgs(
  actionName: string,
  schema: ActionArgumentSchema[],
  argv: string[],
): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (!token.startsWith('--')) {
      throw new ActionArgumentError(`Action ${actionName}: unexpected positional argument: ${token}`)
    }
    const equals = token.indexOf('=')
    const flagName = token.slice(2, equals === -1 ? undefined : equals)
    if (flagName.length === 0) throw new ActionArgumentError(`Action ${actionName}: empty flag name`)
    const schemaEntry = schema.find((arg) => arg.name === flagName)
    if (!schemaEntry) throw new ActionArgumentError(`Action ${actionName}: unknown flag --${flagName}`)

    if (equals !== -1) {
      raw[flagName] = token.slice(equals + 1)
      continue
    }
    if (schemaEntry.type === 'boolean') {
      raw[flagName] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new ActionArgumentError(`Action ${actionName}: flag --${flagName} requires a value`)
    }
    raw[flagName] = value
    index++
  }
  return validateActionArgs(actionName, schema, raw)
}

export function actionsApiRoutes(
  registry: ActionRegistry,
): Record<string, unknown> {
  return {
    [actionsApiPath]: {
      GET: () => Response.json(registry.list()),
    },
    [`${actionsApiPath}/:name`]: {
      POST: async (request: Request) => {
        const name = new URL(request.url).pathname.slice(actionsApiPath.length + 1)
        let args: Record<string, unknown>
        try {
          args = await request.json() as Record<string, unknown>
        } catch {
          return new Response('Invalid JSON body', { status: 400 })
        }
        try {
          return Response.json(await registry.call(name, args))
        } catch (error) {
          if (error instanceof ActionNotFoundError) return new Response(error.message, { status: 404 })
          if (error instanceof ActionArgumentError) return new Response(error.message, { status: 400 })
          return new Response(error instanceof Error ? error.message : String(error), { status: 500 })
        }
      },
    },
  }
}

export function actionsConsoleResponse(): Response {
  return new Response(actionsConsoleHtml(), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

function actionsConsoleHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BunDesk Actions</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #1f2933; }
  h1 { font-size: 1.25rem; }
  .action { border: 1px solid #d2d6dc; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
  .action h2 { font-size: 1rem; margin: 0 0 0.25rem; }
  .action .description { color: #52606d; margin: 0 0 0.75rem; font-size: 0.875rem; }
  .action .cli-hint { font-family: monospace; font-size: 0.75rem; color: #9b2c2c; background: #fff5f5; border-radius: 4px; padding: 0.25rem 0.5rem; display: inline-block; margin-bottom: 0.75rem; }
  label { display: block; margin-bottom: 0.5rem; font-size: 0.875rem; }
  label span { display: block; margin-bottom: 0.25rem; color: #3e4c59; }
  input[type=text], input[type=number], textarea { width: 100%; box-sizing: border-box; padding: 0.375rem; border: 1px solid #d2d6dc; border-radius: 4px; font: inherit; }
  textarea { min-height: 4rem; font-family: monospace; }
  button { margin-top: 0.5rem; padding: 0.375rem 0.875rem; border: none; border-radius: 4px; background: #2563eb; color: white; font: inherit; cursor: pointer; }
  pre { background: #f5f7fa; border: 1px solid #d2d6dc; border-radius: 4px; padding: 0.75rem; overflow-x: auto; font-size: 0.8125rem; }
  .error { color: #9b2c2c; }
</style>
</head>
<body>
<h1>BunDesk Actions</h1>
<p>Every action below is also reachable from the CLI (<code>my-app &lt;name&gt; --arg value</code>)
and the API (<code>POST /api/actions/&lt;name&gt;</code>).</p>
<div id="actions"></div>
<script>
const container = document.getElementById('actions');
const render = async () => {
  const actions = await fetch('/api/actions').then((r) => r.json());
  container.innerHTML = '';
  for (const action of actions) {
    const card = document.createElement('section');
    card.className = 'action';
    const hint = document.createElement('span');
    hint.className = 'cli-hint';
    const exampleArgs = action.args.map((a) => a.type === 'boolean' ? '--' + a.name : '--' + a.name + ' <' + a.type + '>').join(' ');
    hint.textContent = 'my-app ' + action.name + (exampleArgs ? ' ' + exampleArgs : '');
    card.appendChild(hint);
    const title = document.createElement('h2');
    title.textContent = action.name;
    card.appendChild(title);
    if (action.description) {
      const description = document.createElement('p');
      description.className = 'description';
      description.textContent = action.description;
      card.appendChild(description);
    }
    const form = document.createElement('form');
    const fields = {};
    for (const arg of action.args) {
      const label = document.createElement('label');
      const caption = document.createElement('span');
      caption.textContent = arg.name + (arg.required ? ' *' : '') + (arg.default !== undefined ? ' (default ' + JSON.stringify(arg.default) + ')' : '');
      label.appendChild(caption);
      let input;
      if (arg.type === 'boolean') {
        input = document.createElement('input');
        input.type = 'checkbox';
      } else if (arg.type === 'json') {
        input = document.createElement('textarea');
        input.placeholder = 'JSON';
      } else {
        input = document.createElement('input');
        input.type = arg.type === 'number' ? 'number' : 'text';
      }
      input.name = arg.name;
      label.appendChild(input);
      form.appendChild(label);
      fields[arg.name] = input;
    }
    const result = document.createElement('pre');
    result.hidden = true;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const args = {};
      for (const arg of action.args) {
        const input = fields[arg.name];
        if (arg.type === 'boolean') {
          if (input.checked) args[arg.name] = true;
        } else if (input.value !== '') {
          args[arg.name] = arg.type === 'number' ? Number(input.value) : input.value;
        }
      }
      result.hidden = false;
      result.className = '';
      result.textContent = 'Running...';
      try {
        const response = await fetch('/api/actions/' + encodeURIComponent(action.name), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args),
        });
        const body = await response.text();
        result.textContent = response.ok ? body : 'Error ' + response.status + ': ' + body;
        if (!response.ok) result.className = 'error';
      } catch (error) {
        result.textContent = String(error);
        result.className = 'error';
      }
    });
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Run';
    form.appendChild(submit);
    form.appendChild(result);
    card.appendChild(form);
    container.appendChild(card);
  }
};
render();
</script>
</body>
</html>`
}
