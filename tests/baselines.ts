// The supported dsh baseline matrix: per-line tag, vendored cordis, and seam faces, probed by the always-on lanes
// and by the per-tag `compat` project that boots the BUILT plugin on real sources.

/** Must stay in lockstep with the BASELINES entries below. */
export type BaselineId = 'v0.2.0-rc.2' | 'v0.2.1-rc.2'

export interface ClientSeam {
  imageFaceMethod: string
  markdownChrome: string
  /** The primitives JsonTree faces the rich-text JSON body rides (the expander DOM, the expanded-row class locals, the labels contract). */
  jsonTree: {
    file: string
    needles: readonly string[]
  }
  /** The tag's declared platform module table (`PLATFORM_MODULES`); every bundle require must resolve here. */
  platformModules: readonly string[]
  detailChannel: {
    hostRpcFile: string
    hostRpcNeedle: string
    clientRpcFile: string
    clientRpcNeedle: string
    registryFile: string
    registryNeedle: string
  }
  /** The session-jump seam: `uiWorkspace.openSession`; the sessions service's `open(id)` was retired by the 0.1.6
   * refactor and is probed absent. */
  sessionNav: {
    workspaceFile: string
    workspaceNeedle: string
    sessionsFile: string
    sessionsOpen: boolean
  }
  /** The subagent history-address resolver (issue #193): the sessions service's direct-parent resolver, plus the
   * listed-summary fallback that exists only on the `0.2.1` line. */
  subagentAddress: {
    file: string
    needle: string
    summaryFallback: boolean
    summaryNeedle: string
  }
  /** The Plugins-panel navigator the settings jump rides: `pluginNavigation.openBundle` (the panel's own verb, never a DOM
   * walk), plus the `0.2.1` contributed-tab machinery whose remembered selection it resets. */
  pluginsNav: {
    file: string
    needle: string
    tabReset: boolean
    tabResetNeedle: string
    tabsSlot: boolean
    tabsSlotFile: string
    tabsSlotNeedle: string
  }
  /** The command panel's coloring seam: the primitives' lazy shiki highlighter, the boot grammar that colors a shell
   *  command's first render, and the token sheet its `--shiki-*` runs resolve against. */
  codeHighlight: readonly { file: string; needle: string; what: string }[]
  /** The first-level panel seam: the layout's keyed `main` slot and the sidebar's `sidebar.panellist` list, addressed by one shared id. */
  insightPage: {
    panellistFile: string
    panellistNeedle: string
    mainFile: string
    mainNeedle: string
  }
  /** The second-mount guard's slot-ledger read: the `slots` service's raw `entries` view, probed on the SERVICE carrying the call (the
   * facade can drop it independently). */
  ledger: {
    file: string
    needle: string
  }
  /** The tab seam: tab-type registry, keyed body + chip-title seats, `openResource` face, guide-entry contract; registration rides an
   * OPTIONAL deferred inject. */
  sidebar: {
    serviceFile: string
    serviceNeedle: string
    slotFile: string
    slotNeedle: string
    titleSlotNeedle: string
    nav: {
      file: string
      needle: string
    }
    guideEntry: {
      file: string
      fields: readonly string[]
    }
  }
}

export interface Baseline {
  id: BaselineId
  tag: string
  /** The dsh release version the tag names; the admission gate's runtime version. */
  version: string
  cordis: string
  /** The `dsh-session` release this line vendors; the staged sources import runtime values from it, so the driver resolves to the tag's
   * own generation. */
  session: string
  /** The fold's switched families; the matrix reads fold.ts `case` labels and asserts each is declared here, so a new fold case fails
   * loudly. */
  foldEventTypes: readonly string[]
  client: ClientSeam
  /** The step-boundary identity seam: the agent-loop file dispatching `agent/pre-step`, plus a plugin proving the `prepend` listener
   * option. */
  stepGuard: {
    loopFile: string
    loopNeedles: readonly string[]
    prependProofFile: string
  }
  /** The V4+ Config-form settings surface: forms derive from each entry's Config schema, `settings.register` is probed absent, browser
   * half rides `configForms`. */
  settings: {
    serviceFile: string
    register: boolean
    cardSlot: string
    cardSlotFiles: readonly string[]
    transport: 'configForms'
    transportFile: string
    transportPresent: boolean
  }
  /** The balance seam: the settings row read off the redacted Config-form `describe()` projection (stock ids fallback); the retired
   * `get(ns)` read is probed absent. */
  balance: {
    settingsFile: string
    settingsGetNeedle: string
    settingsGetPresent: boolean
    settingsDescribeNeedle: string
    settingsRedactNeedle: string
    /** The provider directory: the route key's own settings id, whatever the entry is called. */
    providerDirectory: { file: string; needle: string }
    /** The DeepSeek stock entry ids — the fold's fallback when the provider directory answers nothing; the
     * set grows with the line. */
    stockIds: { file: string; ids: readonly string[] }
    providerFiles: readonly { file: string; needles: readonly string[] }[]
  }
  /** The prompt injection seam: the ordered-section face + order anchors, and the loader's volatile-only commit so
   * edits apply next step. */
  prompt: {
    serviceFile: string
    sectionNeedle: string
    orderAnchors: readonly string[]
    loaderVolatileFile: string
    loaderVolatileNeedle: string
  }
  /** The sliced cold fold's optional faces: `sessionProjections.restore`/`hydrate`, `sessions.prepare`, and
   * `sessionProjectionCache.write`; any absence keeps the single-shot `coldSnapshot` path. */
  backfillFold: {
    registryFile: string
    storeFile: string
    cacheFile: string
  }
}

const DEFAULT_PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

function baseline(id: BaselineId, tag: string, session: string, line: {
  cordis?: string
  stockIds?: readonly string[]
  extraFoldEvents?: readonly string[]
  platformModules?: readonly string[]
} = {}): Baseline {
  return {
    id,
    tag,
    version: tag.replace(/^dsh-v/, ''),
    cordis: line.cordis ?? '4.0.4',
    session,
    foldEventTypes: [
      'request/header', 'request/context', 'step/start', 'step/end',
      'user/message', 'developer/message', 'tool/call', 'tool/result', 'assistant/message', 'assistant/attempt',
      'tool/ptc-dispatch', 'tool/ptc-dispatch-start',
      'plan/mode', 'compaction/summary', 'compaction/prune', 'system/message',
      'approval/asked', 'approval/decided', 'session/end-seed',
      ...(line.extraFoldEvents ?? []),
    ],
    client: {
      imageFaceMethod: 'imageUrl',
      markdownChrome: 'labels',
      jsonTree: {
        file: 'packages/client/ui-primitives/src/JsonTree.tsx',
        needles: ['data-json-expander', 'aria-expanded', 'css.summary', 'css.preview', 'css.punctuation', 'expandTopLevel', 'copyButtonTitle'],
      },
      platformModules: line.platformModules ?? DEFAULT_PLATFORM_MODULES,
      detailChannel: {
        hostRpcFile: 'packages/client/connection/src/rpc.ts',
        hostRpcNeedle: 'HostConnectionRpc',
        clientRpcFile: 'packages/client/connection/src/client/rpc.ts',
        clientRpcNeedle: 'call(channel, endpoint, payload',
        registryFile: 'packages/session/session-projection/src/index.ts',
        registryNeedle: 'stateOf<',
      },
      sidebar: {
        serviceFile: 'packages/client/ui-sidebar-right/src/client/index.ts',
        serviceNeedle: 'sidebarRightTabs',
        slotFile: 'packages/client/ui-sidebar-right/src/client/contract/slots.ts',
        slotNeedle: 'sidebar.right.pane.tab',
        titleSlotNeedle: 'sidebar.right.pane.tab.title',
        nav: {
          file: 'packages/client/ui-sidebar-right/src/client/service.ts',
          needle: 'openResource(address',
        },
        guideEntry: {
          file: 'packages/client/ui-sidebar-right/src/client/tab-registry.ts',
          fields: [
            'readonly order: number',
            'readonly title: () => string',
            'readonly description?: () => string',
            'readonly icon?: ComponentType<IconProps>',
          ],
        },
      },
      sessionNav: {
        workspaceFile: 'packages/client/ui-workspace/src/client/navigation.ts',
        workspaceNeedle: 'openSession(target: SessionTarget): void',
        sessionsFile: 'packages/api/session-controller/src/client/contract/sessions.ts',
        sessionsOpen: false,
      },
      codeHighlight: [
        { file: 'packages/client/ui-primitives/src/code-highlighting.ts', needle: 'useCodeHighlighter', what: 'the highlighter hook the panel binds' },
        { file: 'packages/client/ui-primitives/src/markdown/highlight.ts', needle: "lang: 'shellscript'", what: 'the shell grammar is pre-tokenized at boot' },
        { file: 'packages/client/ui-primitives/src/markdown/highlight.ts', needle: '@shikijs/langs/powershell', what: 'the pwsh grammar loads through the lazy table' },
        { file: 'packages/client/ui-theme/src/styles/shiki.css', needle: 'shiki-token-function', what: 'the token sheet the runs resolve against' },
      ],
      subagentAddress: {
        file: 'packages/api/session-controller/src/client/sessions/manager.ts',
        needle: 'subagentAddress',
        summaryFallback: id === 'v0.2.1-rc.2',
        summaryNeedle: 'summary?.origin',
      },
      pluginsNav: {
        file: 'packages/client/ui-plugin-manager/src/client/index.ts',
        needle: "'pluginNavigation', {",
        tabReset: id === 'v0.2.1-rc.2',
        tabResetNeedle: 'instance.actions.setTab',
        tabsSlot: id === 'v0.2.1-rc.2',
        tabsSlotFile: 'packages/client/ui-plugin-manager/src/client/slot-contract.ts',
        tabsSlotNeedle: "'plugins.tab'",
      },
      insightPage: {
        panellistFile: 'packages/client/ui-sidebar/src/client/contract/slots.ts',
        panellistNeedle: "'sidebar.panellist'",
        mainFile: 'packages/client/ui-layout/src/client/index.ts',
        mainNeedle: "'main': { kind: 'keyed'",
      },
      ledger: {
        file: 'packages/client/ui-renderer/src/client/registry.ts',
        // Truncated before the parameter list: the probe greps tag sources as basic regexes, where `(` and `[` open groups/classes.
        needle: 'entries(key: keyof SlotMap',
      },
    },
    settings: {
      serviceFile: 'packages/settings/settings/src/index.ts',
      register: false,
      cardSlot: 'plugins.bundle.config',
      cardSlotFiles: ['packages/client/ui-plugin-manager/src/**'],
      transport: 'configForms',
      transportFile: 'packages/client/ui-settings/src/client/config-form.ts',
      transportPresent: true,
    },
    balance: {
      settingsFile: 'packages/settings/settings/src/index.ts',
      settingsGetNeedle: 'get<const Namespace extends string>(ns:',
      settingsGetPresent: false,
      settingsDescribeNeedle: 'describe(options?: SettingsDescribeOptions)',
      settingsRedactNeedle: 'redactSecrets?: boolean',
      providerDirectory: {
        file: 'packages/llm/llm/src/index.ts',
        needle: 'listConfigurableProviders(): LlmConfigurableProvider',
      },
      stockIds: {
        file: 'packages/bundle/base/cordis.patch.yml',
        ids: line.stockIds ?? ['llm-deepseek', 'web-search-deepseek'],
      },
      providerFiles: [
        {
          file: 'packages/llm/llm-deepseek-api-key/src/index.ts',
          needles: ["const PROVIDER = 'deepseek-official'"],
        },
        {
          file: 'packages/llm/llm-deepseek-api-key/src/config.ts',
          needles: ["apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY').volatile()"],
        },
        {
          file: 'packages/llm/llm-deepseek/src/config.ts',
          needles: ['baseURL: z.string().volatile()'],
        },
      ],
    },
    stepGuard: {
      loopFile: 'packages/core/agent-loop/src/agent.ts',
      loopNeedles: ["'agent/pre-step'", "append('user/message'"],
      prependProofFile: 'packages/context/time-context/src/index.ts',
    },
    prompt: {
      serviceFile: 'packages/core/system-prompt/src/index.ts',
      sectionNeedle: 'section(section: PromptSection)',
      orderAnchors: ['HARNESS_IDENTITY', 'DEPLOYMENT_PERSONA_SUFFIX'],
      loaderVolatileFile: 'vendor/loader/src/config/entry.ts',
      loaderVolatileNeedle: 'updateVolatile(ref, source)',
    },
    backfillFold: {
      registryFile: 'packages/session/session-projection/src/index.ts',
      storeFile: 'packages/core/session/src/index.ts',
      cacheFile: 'packages/session/session-projection-cache/src/index.ts',
    },
  }
}

export const BASELINES: readonly Baseline[] = [
  // The oldest supported line, V4: the floor because its npm dependency closure is complete (docs/compatibility.md
  // §1); every seam below is spelled at this tag, and cordis stays 4.0.4.
  baseline('v0.2.0-rc.2', 'dsh-v0.2.0-rc.2', '0.2.0-rc.2'),
  // Two facts differ from 0.2.0: cordis 4.0.5, and the `web-deepseek-api` stock entry the balance fold falls back to.
  // The durable job events (`job/registered` / `job/settled`) exist only on this line — the command log degrades to
  // envelope-derived timing without them.
  baseline('v0.2.1-rc.2', 'dsh-v0.2.1-rc.2', '0.2.1-rc.2', {
    cordis: '4.0.5',
    stockIds: ['llm-deepseek', 'web-search-deepseek', 'web-deepseek-api'],
    platformModules: [...DEFAULT_PLATFORM_MODULES, 'zod', '@tanstack/react-virtual'],
    extraFoldEvents: ['job/registered', 'job/settled'],
  }),
]
