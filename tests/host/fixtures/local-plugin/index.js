// Fixture: a locally linked third-party plugin registering against a handed-in tools service.

export function registerTool(tools) {
  tools.register({ name: 'local_tool', description: 'from a local link' })
}