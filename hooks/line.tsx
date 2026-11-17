// ABOUTME: Draws the footer's agents line from its segments, for the footer's own tree and for the surface
// ABOUTME: module that animates it: each agent's brand, each style's Text props, the spinner's frames and the elapsed time.
import type { ElementConstructor, RenderElement, TextProps } from 'claude-code'

import type { Agent, LineSegment } from '../types'

// OpenAI's brand green, so the Codex parts of the line read as Codex's.
const OPENAI_GREEN = '#10A37F'
// Each agent's name as the line shows it, in the accent of its own interface, so each group reads as that agent's:
// pi's default dark theme's accent okhsl(295 50% 67%), and omp's default dark theme's accent.
export const AGENTS: Record<Agent, { name: string; color: string }> = {
  codex: { name: 'Codex', color: OPENAI_GREEN },
  pi: { name: 'pi', color: '#A798D7' },
  omp: { name: 'omp', color: '#FEBC38' },
}
export const FRAME_MS = 100
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const STYLES: Record<Extract<LineSegment, { kind: 'text' }>['style'], TextProps> = {
  plain: {},
  dim: { dimColor: true },
  warning: { color: 'warning' },
}

// One Text holding every segment; frame is the spinner's, null where nothing animates it, and now the time
// the elapsed segments count to.
export function drawLine(Text: ElementConstructor<TextProps>, segments: LineSegment[], frame: number | null, now: number): RenderElement {
  return (
    <Text>
      {segments.map(segment => {
        switch (segment.kind) {
          case 'agent':
            return <Text key={segment.key} color={AGENTS[segment.agent].color} bold>{AGENTS[segment.agent].name}</Text>
          case 'text':
            return <Text key={segment.key} {...STYLES[segment.style]}>{segment.text}</Text>
          case 'spinner':
            return frame === null ? null : <Text key={segment.key}>{`${FRAMES[frame % FRAMES.length]} `}</Text>
          case 'elapsed':
            return <Text key={segment.key}>{elapsed(now - segment.busySince)}</Text>
        }
      })}
    </Text>
  )
}

// 14s, 2m14s, 1h02m. A turn start ahead of this clock counts as just begun.
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  if (minutes === 0) return `${seconds}s`
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}
