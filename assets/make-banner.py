# ABOUTME: Draws assets/banner.svg: the Work with Codex button, Claude's split plan and question, then the brief,
# ABOUTME: Codex's work and the outcome, looping in a terminal split into Claude Code and Codex.
"""Usage: python3 assets/make-banner.py [--frame SECONDS] [OUT]

Every beat is one opacity track on the same loop, so the story stays in step.
--frame writes a static SVG with each track resolved at that time, for looking
at one beat. magick cannot draw this file's text, so a frame is looked at in
Chrome, at the viewBox size and at 900 px, about the width GitHub gives a README
image (the window height is the width times 760/1200):

    python3 assets/make-banner.py --frame 9 /tmp/frame.svg
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \\
        --window-size=900,570 --screenshot=/tmp/frame.png file:///tmp/frame.svg

The type is sized to stay at least 11 px at 900 px wide, so a pane holds about
61 characters; a line that would run past its pane stops the generator.

Names, paths, hashes and ids are invented.
"""
import argparse, pathlib

parser = argparse.ArgumentParser()
parser.add_argument("--frame", type=float, help="seconds into the loop to freeze at")
parser.add_argument("out", nargs="?", default=pathlib.Path(__file__).resolve().parent / "banner.svg")
args = parser.parse_args()

CYCLE = 15.0
FADE = 0.15
W, H = 1200, 760
WX, WY, WW, WH = 16, 12, W - 32, H - 24
BAR = 40
PANE_W = WW // 2
LEFT, RIGHT = WX, WX + PANE_W
INSET = 20
MARGIN = 12
SIZE = 15
LH = 22
CHAR_W = SIZE * 0.602  # the mono face's advance, as iterm-agents-sidebar's banner measured it
CAP = int((PANE_W - INSET - MARGIN) / CHAR_W)

TERM_BG, TITLE_BG, EDGE = "#141416", "#0a0a0b", "#26262a"
FG, DIM = "#e5e5ea", "#8e8e93"
CLAUDE, LIT = "#d97757", "#8ec07c"
# OpenAI's green, as the band draws the Codex parts of its line.
CODEX = "#10A37F"
ADDED, REMOVED = "#7ccf8a", "#f0857a"
POINTER_FILL, POINTER_EDGE = "#1c1c1e", "#ffffff"
MESSAGE_BG = "#202024"

SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace"

JOB = "errand-3f9c2a71-8d4e-4b6a-9e15-7c0d2b84a6f3"
THREAD = "01a1b2c3-0000-7000-8000-000000000001"
BRIEF_COPY = f"~/.local/state/claude-errands/jobs/{JOB}.brief.md"
SESSION = "~/work/probe"
REPO = f"{SESSION}/repo"
WORKTREE = f"{SESSION}/worktrees/timeouts"
BRANCH = "job/timeouts"
BASE = "4b1d9e2"
DRAFT = "ps and lsof can hang on a loaded machine"
SUBJECT = "Time out ps and lsof after 5 s"
FINAL = "ps and lsof time out after 5 s; npm test passes."

out = []
A = out.append


def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def clip(text, width):
    """The text cut to width characters, its last one an ellipsis when cut."""
    return text if len(text) <= width else text[:width - 1] + "…"


def track(*shown):
    """Opacity points over the loop for the spans of seconds an element shows.
    A span from 0 is shown as the loop starts; one to CYCLE is shown as it ends."""
    points = [(0.0, 1.0 if shown[0][0] == 0 else 0.0)]
    for on, off in shown:
        if on > 0:
            points += [(on, 0.0), (min(on + FADE, CYCLE), 1.0)]
        if off < CYCLE:
            points += [(off, 1.0), (min(off + FADE, CYCLE), 0.0)]
    points.append((CYCLE, points[-1][1]))
    times = [t for t, _ in points]
    assert times == sorted(times), f"spans overlap or run backwards: {shown}"
    return points


def value_at(points, t):
    for (t0, v0), (t1, v1) in zip(points, points[1:]):
        if t0 <= t <= t1:
            return v0 if t1 == t0 else v0 + (v1 - v0) * (t - t0) / (t1 - t0)
    return points[-1][1]


def group(*shown):
    """Opens a <g> that shows only in the given spans; the caller closes it."""
    points = track(*shown)
    if args.frame is not None:
        A(f'<g opacity="{value_at(points, args.frame % CYCLE):.2f}">')
        return
    values = ";".join(f"{v:g}" for _, v in points)
    key_times = ";".join(f"{t / CYCLE:.4f}" for t, _ in points)
    A(f'<g opacity="{points[0][1]:g}"><animate attributeName="opacity" dur="{CYCLE:g}s" '
      f'repeatCount="indefinite" values="{values}" keyTimes="{key_times}"/>')


def term(x, y, spans, anchor=None):
    """One terminal line from (text, colour[, weight]) spans laid end to end.
    Refuses a line that would run out of its pane."""
    pane_left = LEFT if x < RIGHT else RIGHT
    width = sum(len(span[0]) for span in spans) * CHAR_W
    start = x - width if anchor == "end" else x
    assert pane_left + MARGIN <= start and start + width <= pane_left + PANE_W - MARGIN, \
        f"runs out of its pane: {''.join(span[0] for span in spans)!r}"
    parts = []
    for span in spans:
        body, colour = span[0], span[1]
        weight = f' font-weight="{span[2]}"' if len(span) > 2 else ""
        parts.append(f'<tspan fill="{colour}"{weight}>{esc(body)}</tspan>')
    end = ' text-anchor="end"' if anchor == "end" else ""
    A(f'<text x="{x:g}" y="{y:g}"{end} xml:space="preserve">{"".join(parts)}</text>')


A(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="100%" role="img" '
  f'aria-label="A terminal split in two: in Claude Code on the left, the Work with Codex button submits a draft, '
  f'Claude shows a split plan and asks the person with AskUserQuestion before writing and sending the brief; '
  f'Codex on the right creates the job\'s worktree beside the '
  f'repository, edits, tests, commits and ends with RESULT: done; Claude then wakes to the outcome, one commit '
  f'and nothing outside the allow-list">')
A('<title>claude-errands</title>')
A(f'''<defs>
<filter id="drop" x="-6%" y="-14%" width="112%" height="140%">
<feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#1c1c1e" flood-opacity="0.22"/>
</filter>
<clipPath id="window"><rect x="{WX}" y="{WY}" width="{WW}" height="{WH}" rx="16"/></clipPath>
</defs>''')
A(f'<g filter="url(#drop)"><rect x="{WX}" y="{WY}" width="{WW}" height="{WH}" rx="16" fill="{TERM_BG}"/></g>')
A('<g clip-path="url(#window)">')

# ------------------------------------------------------------- window chrome
A(f'<rect x="{WX}" y="{WY}" width="{WW}" height="{BAR}" fill="{TITLE_BG}"/>')
A(f'<line x1="{WX}" y1="{WY + BAR}" x2="{WX + WW}" y2="{WY + BAR}" stroke="{EDGE}"/>')
A(f'<line x1="{RIGHT}" y1="{WY + BAR}" x2="{RIGHT}" y2="{WY + WH}" stroke="{EDGE}"/>')
for i, colour in enumerate(("#ff5f57", "#febc2e", "#28c840")):
    A(f'<circle cx="{WX + 24 + i * 20}" cy="{WY + BAR // 2}" r="6" fill="{colour}"/>')
A(f'<g font-family="{SANS}" font-size="{SIZE}" font-weight="600" text-anchor="middle">')
A(f'<text x="{LEFT + PANE_W / 2:g}" y="{WY + 26}"><tspan fill="{CLAUDE}">✻</tspan>'
  f'<tspan fill="{FG}"> Claude Code</tspan></text>')
A(f'<text x="{RIGHT + PANE_W / 2:g}" y="{WY + 26}"><tspan fill="{CODEX}">&gt;_</tspan>'
  f'<tspan fill="{FG}"> Codex</tspan></text>')
A('</g>')

A(f'<g font-family="{MONO}" font-size="{SIZE}">')

# --------------------------------------------------------- Claude Code, left
lx = LEFT + INSET
ly = WY + BAR + 30
DOT = "⏺ "
HANG = "  ⎿  "
UNDER = "     "
SEND = "node …/src/cli.ts send briefs/timeouts.md"
WAIT = "node …/src/cli.ts wait"

POINTER = (0.4, 1.8)
PRESS = (1.1, 1.6)
SUBMITTED = 1.6
PLANNED = 2.3
QUESTION = 3.0
APPROVED = 4.3
WROTE = 5.3
SENT = 6.0
WAITING = 6.5
SCROLLED = 11.4
LOOP_END = 14.6


def row(n):
    return ly + n * LH


def sent_lines(first):
    term(lx, row(first), [(DOT, LIT), ("Bash", FG, 700), (f"({SEND})", FG)])
    term(lx, row(first + 1), [(HANG, DIM), (JOB, DIM)])


def wait_lines(first):
    term(lx, row(first), [(DOT, LIT), ("Bash", FG, 700), (f"({WAIT}", FG)])
    term(lx, row(first + 1), [("  ", DIM), (f"{JOB})", FG)])


# Beat 1: the button submits the draft and asks Claude to plan the split.
group((SUBMITTED, SCROLLED))
term(lx, row(0), [("❯ ", DIM), (DRAFT, FG)])
term(lx, row(1), [("  ", DIM), (clip("Plan how we split this task with the Codex sessions open here: "
                                    f'{THREAD} in "{SESSION}".', CAP - 2), DIM)])
A('</g>')

# Beat 2: Claude shows the split and asks the person how to proceed.
group((PLANNED, WROTE))
term(lx, row(3), [(DOT, FG), ("Codex adds ps/lsof timeouts and tests.", FG)])
term(lx, row(4), [("  I keep the review.", FG)])
term(lx, row(5), [(f"  One job in {BRANCH}.", FG)])
A('</g>')
group((QUESTION, WROTE))
term(lx, row(7), [("←  ☐ Split plan  →", DIM)])
term(lx, row(8), [("Send this job to Codex?", FG)])
term(lx, row(9), [("❯ 1. Send as planned", FG)])
term(lx, row(10), [("  2. Change the split", FG)])
term(lx, row(11), [("  3. Do it all here", FG)])
A('</g>')
group((APPROVED, WROTE))
term(lx, row(9), [("❯ 1. Send as planned", LIT, 700)])
A('</g>')

# Beat 3: Claude writes the brief after the person approves the plan.
group((WROTE, SCROLLED))
term(lx, row(3), [(DOT, LIT), ("Write", FG, 700), ("(briefs/timeouts.md)", FG)])
term(lx, row(4), [(HANG, DIM), ("Wrote 24 lines to briefs/timeouts.md", DIM)])
for n, line in enumerate((f"# Job: {SUBJECT}", "", "## Worktree", WORKTREE, f"Branch: {BRANCH}",
                          f"Repo: {REPO}", f"Base: {BASE}", "… +17 lines (ctrl+o to expand)")):
    term(lx, row(5 + n), [(UNDER, DIM), (line, DIM)])
A('</g>')

# Beat 4: send prints the job id, and wait goes to the background.
group((SENT, SCROLLED))
sent_lines(14)
A('</g>')
group((WAITING, SCROLLED))
wait_lines(17)
term(lx, row(19), [(HANG, DIM), ("Running in the background", DIM)])
term(lx, row(21), [(DOT, FG), ("Sent. The wait wakes me when Codex's turn ends.", FG)])
A('</g>')

# Beat 6: the transcript has scrolled, and the wait prints what render() prints.
group((SCROLLED + FADE, LOOP_END))
wait_lines(0)
outcome = [f"Job: {JOB}", "Outcome: done", "Final answer:", FINAL, "RESULT: done",
           "Commits:", f"  9c41e07 {SUBJECT}", "Outside allow-list:", "  none",
           "Modified before this job:", "  none", "Uncommitted changes: no"]
for n, line in enumerate(outcome):
    term(lx, row(2 + n), [(HANG if n == 0 else UNDER, DIM), (line, FG)])
term(lx, row(15), [(DOT, FG), ("Codex is done: one commit, nothing outside the list.", FG)])
A('</g>')

# The band above the prompt, as hooks/register.tsx draws it, then the prompt.
band_right = RIGHT - MARGIN - 4
box_top = WY + WH - 84
band_y = box_top - 18
BUTTON = "↗ Work with Codex"
term(band_right, band_y, [("Codex", CODEX, 700), (" session in this folder: ", FG), (THREAD[:8], FG),
                          (" (.)", DIM), ("  ", FG), (BUTTON, CODEX)], anchor="end")
button_w = len(BUTTON) * CHAR_W + 12
group(PRESS)
A(f'<rect x="{band_right - button_w + 6:.1f}" y="{band_y - 16}" width="{button_w:.1f}" height="{LH}" rx="4" fill="{CODEX}"/>')
term(band_right, band_y, [(BUTTON, "#04140f", 700)], anchor="end")
A('</g>')

rule_l, rule_r = LEFT + MARGIN, RIGHT - MARGIN
A(f'<g stroke="{DIM}" opacity="0.5"><line x1="{rule_l}" y1="{box_top}" x2="{rule_r}" y2="{box_top}"/>'
  f'<line x1="{rule_l}" y1="{box_top + 38}" x2="{rule_r}" y2="{box_top + 38}"/></g>')
term(lx, box_top + 25, [("❯ ", DIM)])
group((0, SUBMITTED), (LOOP_END + FADE, CYCLE))
term(lx + 2 * CHAR_W, box_top + 25, [(DRAFT, FG)])
A(f'<rect x="{lx + (2 + len(DRAFT)) * CHAR_W + 1:.1f}" y="{box_top + 10}" width="{CHAR_W:.1f}" '
  f'height="{LH - 2}" fill="{FG}" opacity="0.7"/>')
A('</g>')
MODE = "  ⏵⏵ accept edits on"
term(lx, box_top + 60, [(MODE, DIM)])
group((WAITING, SCROLLED))
term(lx + len(MODE) * CHAR_W, box_top + 60, [(" · 1 background task", DIM)])
A('</g>')

# The pointer comes to the button and presses it.
group(POINTER)
A(f'<path d="M0,0 L0,19 L4.6,14.6 L7.6,21.2 L10.6,19.9 L7.7,13.4 L13.7,13Z" '
  f'transform="translate({band_right - 40:.1f},{band_y + 1})" fill="{POINTER_FILL}" '
  f'stroke="{POINTER_EDGE}" stroke-width="1.6" stroke-linejoin="round"/>')
A('</g>')

# ------------------------------------------------------------- Codex, right
rx = RIGHT + INSET
head_top = WY + BAR + 12
HEADER = [(">_ ", DIM), ("OpenAI Codex", FG, 700), (" (v0.163.0)", DIM)]
header_w = (sum(len(span[0]) for span in HEADER) + 3) * CHAR_W
A(f'<rect x="{RIGHT + MARGIN}" y="{head_top}" width="{header_w:.1f}" height="60" rx="6" fill="none" '
  f'stroke="{EDGE}" stroke-width="1.5"/>')
term(rx, head_top + 24, HEADER)
term(rx, head_top + 48, [("directory: ", DIM), (SESSION, FG)])

ry = head_top + 60 + 30

DELIVERED = 6.8
WORKTREE_ADDED, EDITED, TESTED, COMMITTED, ENDED = 7.6, 8.4, 9.2, 9.9, 10.6


def rrow(n):
    return ry + n * LH


# Beat 5: the job arrives as a message, as messageFor in src/cli.ts writes it, and Codex does the work.
message = [f"First create the job's worktree: git -C {REPO} worktree add -b {BRANCH} {WORKTREE} {BASE}",
           f"Read {BRIEF_COPY} in full and do exactly what it says. This is job {JOB}.",
           f"Work only in {WORKTREE}; run every command and git command there."]
group((DELIVERED, LOOP_END))
A(f'<rect x="{RIGHT + 1}" y="{rrow(0) - LH + 6}" width="{PANE_W - 1}" height="{(len(message) + 1) * LH + 6}" '
  f'fill="{MESSAGE_BG}"/>')
for n, line in enumerate(message):
    term(rx, rrow(n), [("› " if n == 0 else "  ", DIM), (clip(line, CAP - 2), FG)])
term(rx, rrow(len(message)), [("  ", DIM), ("…", FG)])
A('</g>')


def ran(n, command, output):
    """A command Codex ran, its second line under a │ as Codex wraps one, then its output."""
    term(rx, rrow(n), [("• ", CODEX), ("Ran ", FG, 700), (command[0], FG)])
    for k, more in enumerate(command[1:], 1):
        term(rx, rrow(n + k), [("  │ ", DIM), (more, FG)])
    term(rx, rrow(n + len(command)), [("  └ ", DIM), (output, DIM)])


group((WORKTREE_ADDED, LOOP_END))
ran(5, [f"git -C {REPO} worktree add -b {BRANCH}", f"{WORKTREE} {BASE}"],
    f"Preparing worktree (new branch '{BRANCH}')")
A('</g>')

group((EDITED, LOOP_END))
term(rx, rrow(8), [("• ", CODEX), ("Edited ", FG, 700), ("worktrees/timeouts/src/probe.ts ", FG),
                   ("(", DIM), ("+2", ADDED), (" ", DIM), ("-2", REMOVED), (")", DIM)])
diff = [("18 -", REMOVED, "  execFile('ps', args, done)"),
        ("18 +", ADDED, "  execFile('ps', args, { timeout: 5000 }, done)"),
        ("24 -", REMOVED, "  execFile('lsof', args, done)"),
        ("24 +", ADDED, "  execFile('lsof', args, { timeout: 5000 }, done)")]
for n, (mark, colour, code) in enumerate(diff):
    term(rx, rrow(9 + n), [("    ", DIM), (mark, DIM), (code, colour)])
A('</g>')

group((TESTED, LOOP_END))
ran(13, ["(cd worktrees/timeouts && npm test)"], "38 passed")
A('</g>')

group((COMMITTED, LOOP_END))
ran(15, ["git -C worktrees/timeouts commit -am", f'"{SUBJECT}"'], f"[{BRANCH} 9c41e07] {SUBJECT}")
A('</g>')

group((ENDED, LOOP_END))
WORKED = "─ Worked for 1m 12s "
term(rx, rrow(19), [(WORKED, DIM)])
A(f'<line x1="{rx + len(WORKED) * CHAR_W:.1f}" y1="{rrow(19) - 5}" x2="{RIGHT + PANE_W - MARGIN}" '
  f'y2="{rrow(19) - 5}" stroke="{DIM}" opacity="0.5"/>')
term(rx, rrow(20), [("• ", FG), (FINAL, FG)])
term(rx, rrow(21), [("  RESULT: done", FG, 700)])
A('</g>')

# Codex's own prompt, and its working line while the turn runs.
compose_top = WY + WH - 70
assert rrow(21) + LH <= compose_top - 14, "the Codex transcript runs into its working line"
group((DELIVERED + 0.3, ENDED))
term(rx, compose_top - 14, [("• ", CODEX), ("Working ", FG, 700), ("(1m 12s • esc to interrupt)", DIM)])
A('</g>')
A(f'<rect x="{RIGHT + 1}" y="{compose_top}" width="{PANE_W - 1}" height="34" fill="{MESSAGE_BG}"/>')
term(rx, compose_top + 22, [("› ", FG), ("Ask Codex to do anything", DIM)])
term(rx, compose_top + 56, [("  ? for shortcuts", DIM)])

A('</g>')
A('</g>')
A('</svg>')
pathlib.Path(args.out).write_text("\n".join(out) + "\n")
