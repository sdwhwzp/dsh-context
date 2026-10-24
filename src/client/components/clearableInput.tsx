import { useRef, type KeyboardEvent, type ReactElement, type RefObject } from 'react'
import { IconClose } from '../primitives'

export interface ClearableInputProps {
  value: string
  onChange: (value: string) => void
  className: string
  placeholder: string
  /** Accessible name; defaults to the placeholder. */
  label?: string
  clearLabel: string
  type?: 'search' | 'text'
  onKeyDown?: (ev: KeyboardEvent<HTMLInputElement>) => void
  inputRef?: RefObject<HTMLInputElement>
}

/** The wrapper is the flex item; base.css sizes it off the input class, so a new field needs its own wrapper rule. */
export function ClearableInput(props: ClearableInputProps): ReactElement {
  const ownRef = useRef<HTMLInputElement>(null)
  const ref = props.inputRef ?? ownRef
  const filled = props.value !== ''
  return (
    <span className={'lc-searchbox' + (filled ? ' lc-searchbox-on' : '')}>
      <input
        ref={ref}
        type={props.type ?? 'text'}
        className={props.className}
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.label ?? props.placeholder}
        onChange={(ev) => { props.onChange(ev.target.value) }}
        onKeyDown={props.onKeyDown}
      />
      {filled ? (
        <button
          type="button"
          className="lc-searchbox-x"
          title={props.clearLabel}
          aria-label={props.clearLabel}
          onMouseDown={(ev) => { ev.preventDefault() }}
          onClick={() => { props.onChange(''); ref.current?.focus() }}
        >
          <IconClose size={10} />
        </button>
      ) : null}
    </span>
  )
}
