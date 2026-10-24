// Fixture: an anonymous locally linked plugin whose entrypoint carries no name (cordis falls back to the root fiber name).

export function registerBlind(tools) {
  return tools.register({ name: 'blind_tool' })
}