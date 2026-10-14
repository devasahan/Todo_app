# Dayplan

A simple planner for daily work. Each **plan** has a title, a description, a deadline and a status
(**To do → In progress → Done**). You can also add steps, tags and a priority.

It needs no install, no account and no server. Open the page and start planning. Your plans are
saved in your browser.

## Getting started

Open `index.html` in any modern browser. That's it.

If you'd rather serve it locally:

```bash
npm start        # serves the app on http://localhost:5173
```

Because it's static, you can host it anywhere you can put HTML files, such as GitHub Pages.

## What you can do

### Three views of your plans

| View         | What it's for                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Today**    | Your daily dashboard: a greeting, a progress ring for what's due today, your streak, a **Focus now** card with the single most urgent plan, then *Overdue*, *Due today*, *In progress* and *Next 7 days*. |
| **Board**    | A Kanban board with **To do / In progress / Done** columns. Drag cards between columns or reorder them. Sort by your own order, deadline, priority or newest.                                                 |
| **Calendar** | A month view of deadlines. Drag a plan onto another day to reschedule it, double-click a day to add a plan, or drop a plan into **No deadline** to clear its date.                                          |

### Plans

- **Title and description** for the what and the why.
- **Deadline**: a date plus an optional time, with one-tap *Today / Tomorrow / Next week* buttons.
  Cards show how much time is left, color-coded: *Due today at 4:00 PM*, *Due tomorrow*,
  *Overdue by 2 days*.
- **Status**: click the circle on any card to move it forward. Empty means to do, half-filled
  means in progress, a check means done. Finishing a plan gets a small confetti burst.
- **Steps**: break a plan into a checklist, with a progress bar on the card. When every step is
  checked, the app offers to mark the whole plan done.
- **Priority** (low / medium / high), shown as a colored stripe on each card.
- **Tags** like `#work` or `#home`. Click a tag anywhere to filter by it.
- Start, finish and duration are recorded automatically ("took 2 days").

### Quick add with natural language

Type a sentence in the top box and press <kbd>Enter</kbd>. Dates, times, tags and priority are
picked out of the text automatically, and a preview shows what was understood:

> `Finish report fri 3pm #work !high`
> → **Finish report**, due Friday at 3:00 PM, tagged `#work`, high priority

| You type                                                                       | Meaning                                  |
| ------------------------------------------------------------------------------ | ---------------------------------------- |
| `today`, `tonight`, `tomorrow`, `tmrw`                                         | That day (`tonight` also sets 8 PM)      |
| `mon` … `sunday`, `next fri`, `by thursday`                                    | The next such weekday                    |
| `in 3 days`, `in two weeks`, `in a month`                                      | Relative dates                           |
| `next week`, `next month`, `this weekend`, `eow`                               | Next Monday, the 1st, Saturday, Friday   |
| `oct 31`, `3rd of november`, `2026-12-01`                                      | Exact dates                              |
| `3pm`, `9:30am`, `at 18:45`, `noon`                                            | Time (no date means today, or tomorrow if that time has already passed) |
| `#tag`                                                                         | Adds a tag                               |
| `!high` `!!!` `p1` · `!med` `!!` `p2` · `!low` `p3`                            | Priority                                 |

Ordinary words are left alone, so *"enjoy the sun"* or *"SAT exam prep"* stay as typed.
Press <kbd>Shift</kbd>+<kbd>Enter</kbd> to open the full editor with the parsed values filled in.

### Everything else

- **Search** across titles, descriptions, tags and steps. Filter by tag or priority.
- **Undo** for deleting or finishing a plan, rescheduling, clearing completed plans and imports.
- **Dark mode** that follows your system, with a manual toggle.
- **Backups**: export all plans to a `.json` file and import them again from the **⋯** menu.
  Importing merges by plan, so re-importing the same backup never creates duplicates.
- Works on phones: the board columns become swipeable panels, the calendar shows dots, and the
  editor opens as a bottom sheet.
- Stays in sync across open tabs, and deadline labels refresh every minute.

### Keyboard shortcuts

| Key                                  | Action                         |
| ------------------------------------ | ------------------------------ |
| <kbd>N</kbd>                         | New plan (focus quick add)     |
| <kbd>/</kbd>                         | Search                         |
| <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> | Today / Board / Calendar     |
| <kbd>[</kbd> <kbd>]</kbd>            | Previous / next month          |
| <kbd>D</kbd>                         | Toggle dark mode               |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd>     | Save the open plan             |
| <kbd>Esc</kbd>                       | Close dialogs, clear search    |
| <kbd>?</kbd>                         | Show all shortcuts             |

## Where your data lives

Plans are stored in your browser's `localStorage`, on your device only. Nothing is sent anywhere.
Each browser and device keeps its own copy, so use **Export backup** to move plans between them
or to keep a safe copy. Clearing your browser's site data deletes your plans.

## Project layout

```
index.html          Page structure, editor dialog and shortcut sheet
css/styles.css      All styling, light/dark themes and mobile layouts
js/core.js          Pure logic: plan model, quick-add parser, deadlines, sorting, stats
js/app.js           UI: rendering, drag & drop, editor, storage, shortcuts
tests/core.test.js  Unit tests for js/core.js
```

`js/core.js` doesn't touch the page at all, so all the rules (date parsing, what counts as
overdue, streaks and so on) are covered by fast unit tests:

```bash
npm test
```

No dependencies are needed. The tests use Node's built-in test runner (Node 18+).
