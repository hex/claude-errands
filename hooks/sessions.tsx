// ABOUTME: The band's sessions text while a Codex session works, as a surface module: it turns the spinner
// ABOUTME: and counts the elapsed time on the surface's frame clock between the band's redraws.
import type { ClientModule } from 'claude-code'

import type { SessionsLineProps } from '../types'
import { FRAME_MS, drawLine } from './line'

// ticks: frames since the instance mounted, which turn the spinner; now and since: the band's clock as of its
// last redraw and the tick it arrived on, which the elapsed time counts on from.
type Ticking = { ticks: number; now: number; since: number }

const SessionsLine: ClientModule<SessionsLineProps, Ticking> = (props, surface) => {
  const state = surface.state
  if (state === undefined) {
    surface.every(FRAME_MS, () => {
      const current = surface.state
      if (current !== undefined) surface.setState({ ...current, ticks: current.ticks + 1 })
    })
    surface.setState({ ticks: 0, now: props.now, since: 0 })
  } else if (state.now !== props.now) {
    surface.setState({ ...state, now: props.now, since: state.ticks })
  }
  const ticks = state?.ticks ?? 0
  const counted = state !== undefined && state.now === props.now ? (ticks - state.since) * FRAME_MS : 0

  return drawLine(surface.elements.Text, props.segments, ticks, props.now + counted)
}

export default SessionsLine
