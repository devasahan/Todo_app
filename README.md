# Dayplan

A simple planner for daily work. Each **plan** has a title, a description, a deadline and a status
(**To do → In progress → Done**). You can also add steps, tags and a priority.

It needs no install and no server: open the page and start planning, and your plans are saved in
your browser. Put it online (for example on PythonAnywhere, below) and you can also **sign in with
an email and password** to see the same plans in every browser.

## Getting started

Open `index.html` in any modern browser. That's it.

If you'd rather serve it locally:

```bash
npm start        # serves the app on http://localhost:5173
```

Because it's static, you can host it anywhere you can put HTML files. Step-by-step instructions
for PythonAnywhere are below.

## Put it online with PythonAnywhere (free)

This gives Dayplan its own address, like `https://yourname.pythonanywhere.com`, that you can open
from any browser. You can use the same email address as another PythonAnywhere account. Each
account just needs its own username, and you sign in with the username.

**1. Create the account.** If you're signed in to another PythonAnywhere account, log out first
(or use a private browser window). On [pythonanywhere.com](https://www.pythonanywhere.com), choose
*Pricing & signup*, then *Create a Beginner account*. The username you pick becomes your web
address, so `dayplan` gives you `dayplan.pythonanywhere.com`. Lowercase letters are the safest
choice.

Then:
- Open the confirmation email PythonAnywhere sends you and click the link. Without it you won't
  get the warning email before your site is switched off, and you can't reset your password.
- Write down your new username. You sign in with it, not with your email.

**2. Copy Dayplan into your account.** Check that the top right of the page shows your *new*
username. Open the **Consoles** tab, start a **Bash** console and run:

```bash
git clone https://github.com/devasahan/Todo_app.git
```

**3. Create the web app.** Open the **Web** tab, click **Add a new web app**, then **Next**.
Choose **Manual configuration** (not Flask or Django), pick the newest Python version and click
**Next**.

**4. Point the web app at Dayplan.** Still on the **Web** tab, find the **Code** section and click
the link next to **WSGI configuration file** (it looks like
`/var/www/yourname_pythonanywhere_com_wsgi.py`). Delete everything in that file and paste these
three lines, replacing `yourname` with your username:

```python
import sys
sys.path.insert(0, '/home/yourname/Todo_app')
from dayplan_wsgi import application
```

Type the username exactly as you created it. Capital letters matter here, even though the web
address shows it in lowercase. If you're not sure, run `echo $HOME` in a Bash console. It prints
the exact folder, for example `/home/yourname`.

Click **Save**.

**5. Turn on HTTPS only.** Near the bottom of the **Web** tab, in the **Security** section, switch
**Force HTTPS** on. Passwords are then always sent encrypted.

**6. Go live.** Scroll up on the **Web** tab and click the green **Reload** button.

**7. Create your Dayplan account right away.** Open `https://yourname.pythonanywhere.com`, click
**Sign in** (top right) and create an account with your email and a new password that you don't
use anywhere else. **The first account on the site becomes its admin**, so do this before you
share the address with anyone.

(If someone else got there first, you'll see *"Request sent"* or *"isn't accepting new accounts"*
instead of being signed in. Fix it from a Bash console with
`python3 ~/Todo_app/dayplan_api.py make-admin you@example.com`. It creates your account if
needed and asks you for a password. Then sign in and use **Manage users** to turn off and delete
the other account.)

On any other browser or phone, open the same address, click **Sign in** and use the same email and
password. Your plans appear and stay in sync.

### Letting other people use your site

Like most websites, anyone can click **Sign in → Create an account**. Their account then waits for
you: they see *"Request sent"*, and they can't sign in until you approve them. (Sign-up gives the
same answer whether or not an email already has an account, so strangers can't use it to find out
who uses your site.)

- A red number on your account button shows how many people are waiting.
- Open your account button → **Manage users** to **Approve** or **Decline** each request.
- You can also **Turn off** an account (that person is signed out immediately) and turn it back
  on, or **Delete** it together with its plans.
- Turn **Accept new sign-ups** off if you don't want any more requests (for example if strangers
  start spamming). People with accounts can still sign in.

Everyone's plans are private, including from you as admin: **Manage users** shows accounts and
how many plans each has, never what's in them.

**If you see "Something went wrong".** On the **Web** tab, open the **error log** link in the
**Log files** section. The last lines say what failed. A misspelled username in step 4 is the most
common cause (`No module named 'dayplan_wsgi'`).

**Keep it running.** Free web apps are switched off if they aren't extended. About once a month,
log in to **pythonanywhere.com** (with your PythonAnywhere username, not your Dayplan email) and
click **Run until 1 month from today** on the **Web** tab. PythonAnywhere emails you a week before
the deadline.

**Get updates later.** When the code on GitHub changes, run this in a Bash console, then press
**Reload** on the **Web** tab:

```bash
cd ~/Todo_app && git pull
```

Updating never touches your plans: they're stored outside the code, in
`/home/yourname/dayplan-data/`.

**Forgot a password?** The app can't send emails, so passwords are reset from a Bash console. Run
the line below, type a new password twice, and sign in with it (or give it to the person who
forgot theirs). This also signs that account out on every other device.

```bash
python3 ~/Todo_app/dayplan_api.py set-password you@example.com
```

`set-password` only changes existing accounts, so a typo in the email can't create a new one by
mistake; it tells you if there's no such account. Other console commands, handy if you can't get
into the app:

```bash
python3 ~/Todo_app/dayplan_api.py list-users                 # everyone, with their status
python3 ~/Todo_app/dayplan_api.py add-user friend@example.com     # a new, approved account
python3 ~/Todo_app/dayplan_api.py approve friend@example.com
python3 ~/Todo_app/dayplan_api.py make-admin friend@example.com    # creates it if needed
```

**Backups of the server data.** Your plans are in `/home/yourname/dayplan-data/dayplan.sqlite3`;
download a copy from the **Files** tab now and then. If you ever put an older copy back, run
`python3 ~/Todo_app/dayplan_api.py new-epoch` afterwards and **Reload** the web app, so every
browser reloads its plans from the server.

### Moving plans you already have onto the site

Plans you made before (for example by opening `index.html` on your computer) live only in that
browser. To bring them over:

1. Open that copy of Dayplan, click **⋯ → Export backup**. A `.json` file downloads.
2. Open your site, sign in, then click **⋯ → Import backup…** and pick that file.

They're added to your account and appear on every device you sign in on.

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

**Not signed in:** plans are stored in your browser's `localStorage`, on your device only.
Nothing is sent anywhere. Each browser keeps its own copy, so use **Export backup** to move plans
between them or to keep a safe copy. Clearing your browser's site data deletes them.

**Signed in:** plans are also saved to your account on the server, in a SQLite database at
`../dayplan-data/dayplan.sqlite3` (next to the code, never inside it, and never on GitHub). Every
change is sent within a second. Other browsers pick up changes when you open or switch back to
them, and every minute while they're open. If you're offline, changes wait and are sent when
you're back. The dot on your account button shows this: green is saved, amber is saving, grey is
offline.

If the same plan is changed in two places, the most recent change wins, per plan. An older copy
can never overwrite a newer one, so a laptop that was signed out for weeks, a second tab, or an
undo can't bring back old versions or deleted plans. Moving a card or editing one field only
changes that plan.

When you sign in on a browser that already has plans, plans the account doesn't have yet are
added to it. Signing out removes the plans from that browser (they stay safe in your account), so
nothing is left behind on a shared computer.

How it's protected:
- Passwords are never stored, only a salted PBKDF2-SHA256 hash (600,000 rounds).
- You stay signed in with a random session token in an `HttpOnly`, `SameSite=Lax` cookie (and
  `Secure` over HTTPS). Only a hash of the token is stored on the server.
- Ten wrong passwords in 15 minutes from one place lock that email there for the rest of the 15
  minutes, so a stranger can't lock you out of your own account. Each internet connection can try
  at most 5 passwords a minute, and the whole site checks at most 30 a minute, so a flood of
  guesses can't slow it down. A very large flood from many connections can delay new sign-ins
  while it lasts; people who are already signed in aren't affected.
- Each account only ever sees its own plans. The admin manages accounts, not their contents.
- New accounts can't sign in until the admin approves them, and at most 50 requests can wait at
  once, so strangers can't fill up the database.

## Project layout

```
index.html          Page structure, editor dialog and shortcut sheet
css/styles.css      All styling, light/dark themes and mobile layouts
js/core.js          Pure logic: plan model, quick-add parser, deadlines, sorting, stats
js/app.js           UI: rendering, drag & drop, editor, storage, sign-in and sync
dayplan_wsgi.py     Serves the app on PythonAnywhere (only index.html, css/ and js/)
dayplan_api.py      Accounts and plan sync (/api/...), stored in SQLite; also a small CLI
tests/              Unit tests for js/core.js, dayplan_wsgi.py and dayplan_api.py
```

`js/core.js` doesn't touch the page at all, so all the rules (date parsing, what counts as
overdue, streaks and so on) are covered by fast unit tests:

```bash
npm test               # app logic, with Node's built-in test runner (Node 18+)
npm run test:server    # dayplan_wsgi.py and dayplan_api.py, with Python's unittest (Python 3.8+)
```

No dependencies need to be installed: the server side uses only Python's standard library.
