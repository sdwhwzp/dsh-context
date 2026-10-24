/** Named imports resolve defensively: an absent or renamed export would render as React error #130,
 * so each degrades to a render-nothing fallback. */

import type { ReactElement } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

export type IconComponent = (props: IconProps) => ReactElement | null

const ns = primitives as unknown as Record<string, unknown>

function exportOf(name: string, source: Record<string, unknown>): unknown {
  try {
    return source[name]
  } catch {
    return undefined
  }
}

export function resolveIcon(name: string, source: Record<string, unknown> = ns): IconComponent {
  const found = exportOf(name, source)
  return typeof found === 'function' ? found as IconComponent : () => null
}

export const IconBranch = resolveIcon('IconBranchOutlineRegular')
export const IconPlus = resolveIcon('IconPlusOutlineRegular')
export const IconCheck = resolveIcon('IconCheckOutlineRegular')
export const IconCopy = resolveIcon('IconCopyOutlineRegular')
export const IconClose = resolveIcon('IconCloseOutlineRegular')
export const IconSettings = resolveIcon('IconSettingsOutlineMedium')
export const IconChevronDown = resolveIcon('IconChevronDownOutlineMedium')
export const IconChevronUp = resolveIcon('IconChevronUpOutlineMedium')
export const IconSearch = resolveIcon('IconSearchOutlineRegular')
export const IconShare = resolveIcon('IconShareOutlineRegular')

/** The harness's file-type glyph: its props are its own (`path`/`kind`), not an icon's. */
export interface FileGlyphProps {
  path?: string
  kind?: string
  size?: number
  className?: string
}

export type FileGlyphComponent = (props: FileGlyphProps) => ReactElement | null

export function resolveFileGlyph(source: Record<string, unknown> = ns): FileGlyphComponent {
  const found = exportOf('FileTypeIcon', source)
  return typeof found === 'function' ? found as FileGlyphComponent : () => null
}

export const FileTypeGlyph = resolveFileGlyph()
