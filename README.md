# Dayplan

A simple planner for daily work. Each **plan** has a title, a description, a deadline and a status
(**To do → In progress → Done**). You can also add steps, tags and a priority.

It needs no install and no server: open the page and start planning, and your plans are saved in
your browser. Put it online (for example on PythonAnywhere, below) and it becomes a members-only
site: people **sign in with an email and password**, see the same plans in every browser, and new
accounts need the admin's approval.

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

**7. Create your Dayplan account right away.** Open `https://yourname.pythonanywhere.com`. You'll
see a sign-in page that offers to **Create your account**: use your email and a new password that
you don't use anywhere else. **The first account on the site becomes its admin**, so do this
before you share the address with anyone.

(If someone else got there first, you'll see *"Request sent"* or *"isn't accepting new accounts"*
instead of being signed in. Fix it from a Bash console with
`python3 ~/Todo_app/dayplan_api.py make-admin you@example.com`. It creates your account if
needed and asks you for a password. Then sign in and use **Manage users** to turn off and delete
the other account.)

On any other browser or phone, open the same address and sign in with the same email and password.
Your plans appear and stay in sync.

Nobody can use the planner on your site without signing in: visitors only see the sign-in screen.

### Letting other people use your site

Like most websites, anyone can open the **Create account** tab on the sign-in screen. Their account then
waits for you: they see *"Request sent"*, and they can't sign in until you approve them. (Sign-up gives the
same answer whether or not an email already has an account, so strangers can't use it to find out
who uses your site.)

- A red number on your account button shows how many people are waiting.
- Open your account button → **Manage users** to **Approve** or **Decline** each request.
- You can also **Turn off** an account (that person is signed out immediately) and turn it back
  on, or **Delete** it together with its plans.
- Turn **Accept new sign-ups** off if you don't want any more requests (for example if strangers
  start spamming). People with accounts can still sign in.

**What approved people can do: view your meetings, nothing else.** Only you (the admin) plan. Everyone
you approve gets a read-only **Meetings** calendar of your meetings: company, date, start and end
time with the time zone (and their own local time), the meeting link (**Join**), the job description
link, the resume and cover letter PDFs, notes and prep steps, and **Add to my calendar**.
They can't see your other plans, and they can't add, change or delete anything; the server refuses
it, not just the screen. Whatever you change shows up for them within a minute, and once you've
set up email (below) they can also get an email when you add, change or cancel a meeting.

### Email notifications (free, through Gmail)

Dayplan can email the people you've approved when you add, change or cancel a meeting. It costs
nothing: PythonAnywhere's free plan can send email through Gmail, and Gmail sends up to about 500
emails a day. Setting it up takes about five minutes.

**1. Make a new Gmail account just for Dayplan**, for example `yourname.dayplan@gmail.com`, at
[accounts.google.com/signup](https://accounts.google.com/signup). Use a separate account, not your own
Gmail. The password from step 3 is stored on PythonAnywhere, and with a separate account your own
mailbox stays safe even if that password ever got out.

**2. Turn on 2-Step Verification** for the new account: open
[myaccount.google.com/security](https://myaccount.google.com/security) (signed in as the new account)
and switch on **2-Step Verification**. Google requires it for app passwords.

**3. Create an app password.** Open
[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), type a name such as
`Dayplan` and click **Create**. Google shows a 16-letter password once; keep that page open for the
next step. **Never send this password to anyone**: don't paste it in a chat, an email or the code.
It goes only into the console in the next step.

**4. Give it to Dayplan.** In a PythonAnywhere **Bash** console, run:

```bash
python3 ~/Todo_app/dayplan_api.py setup-email
```

Type the new Gmail address, then paste the app password. Nothing shows while you paste; that's
normal. Press Enter, and Enter again to keep `Dayplan` as the sender name. Dayplan sends a test email
to the new Gmail address. When it says the test was sent, emails are on, and there's nothing to
reload. If the test fails, nothing is saved, and the message says what went wrong.

The app password is saved in `/home/yourname/dayplan-data/mail.json`, which only your
PythonAnywhere account can read. It's outside the code, so it never goes to GitHub.

**Sending emails.** The meeting editor has a box at the bottom: **Email approved people about
this**.
- It ticks itself for a new meeting, and when you change the date, time, time zone, company, title,
  links or documents.
- It stays unticked when you only change notes, steps, tags or priority.
- You can tick or untick it yourself before saving. Ticking it on a meeting you didn't change
  sends the details again.
- To tell people a meeting is cancelled, tick the box, then press **Delete**.
- After you drag a meeting to another day on the calendar, the message at the bottom of the
  screen offers **Email people**.

Each email:
- says whether the meeting is new, changed (with what was there before), cancelled or back on;
- gives the time in the meeting's time zone and in the reader's own time zone;
- has the meeting link, the job description link and a calendar file to add it to their
  calendar;
- doesn't include your notes or steps.

**People can turn these emails off** in their account menu: **Email me about meeting changes**.
**Manage users** shows *Emails off* next to anyone who has turned them off, and the top of that
dialog says whether email is set up.

**Limits.** Dayplan sends at most 400 emails a day and 30 rounds of emails an hour, staying below
Gmail's limit, so the Gmail account can't be blocked by mistake.

**If an email doesn't arrive:**
- *Gmail didn't accept the sign-in* (error 535): the app password is wrong, or was removed.
  Changing the Gmail account's password removes app passwords. Create a new app password and run
  `setup-email` again.
- *Couldn't reach Gmail*: now and then Google changes its server addresses and PythonAnywhere's
  free plan can't reach them for a while. Try again later.
- It's in spam: ask people to mark the first email as *Not spam*, or add the address to their
  contacts.

Other email commands:

```bash
python3 ~/Todo_app/dayplan_api.py test-email friend@example.com   # send a test email
python3 ~/Todo_app/dayplan_api.py email-off                       # stop emails, delete the saved password
```

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

Then reload Dayplan on every phone and computer where it's open, so no tab keeps running the old
version.

Updating never touches your plans: they're stored outside the code, in
`/home/yourname/dayplan-data/`.

**Forgot a password?** Passwords aren't reset by email: they're reset from a Bash console. Run
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
| **Today**    | Your daily dashboard: a greeting, a progress ring for what's due today, tiles for *due today*, *overdue*, *in progress* and *done this week*, your streak, a **Focus now** card with the single most urgent plan, then *Overdue*, *Due today*, *In progress* and *Next 7 days*. |
| **Board**    | A Kanban board with **To do / In progress / Done** columns. Drag cards between columns or reorder them. Sort by your own order, deadline, priority or newest.                                                 |
| **Calendar** | A month view of deadlines and meetings. Hover a day to see it at double size with everything on it. Drag a plan onto another day to reschedule it, double-click a day to add a plan, or drop a plan into **No deadline** to clear its date. |

### Plans

- **Title and description** for the what and the why.
- **Deadline**: a date plus an optional time, with one-tap *Today / Tomorrow / Next week* buttons.
  Cards show how much time is left, color-coded: *Due today at 4:00 PM*, *Due tomorrow*,
  *Overdue by 2 days*.
- **Status**: click the circle on any card to move it forward. Empty means to do, half-filled
  means in progress, a check means done. Finishing a plan gets a small confetti burst.
- **Steps**: break a plan into a checklist, with a progress bar on the card. When every step is
  checked, the app offers to mark the whole plan done.
- **Priority** (low / medium / high). High and low plans are marked on their cards with signal bars.
- **Tags** like `#work` or `#home`. Click a tag in the sidebar (or on a card) to filter by it.
- Start, finish and duration are recorded automatically ("took 2 days").

### Meetings and job interviews

Press **New meeting** in the top bar (or <kbd>M</kbd>, or **Meeting** on a calendar day, or the
**⋯** menu on a phone), or switch the editor from **Plan** to **Meeting**. A meeting has:

- **Company**: the title fills itself in as *Interview with Acme* unless you type your own.
- **Date, start time, end time and time zone** of the call: enter the time the way the recruiter
  gave it (say 2:00–3:00 PM New York time). If that isn't your time zone, the editor shows what it
  is for you, and the calendar puts the meeting at your local time, with the other time beside it.
- **Meeting link** (Zoom, Teams, Google Meet…): paste the link, or the whole invitation, and the
  link is picked out of it.
- **Job description link**: the job posting.
- **Resume and cover letter** (PDF, up to 10 MB each): the versions you sent for this job. They're
  stored on your Dayplan site and open in a new tab. (Attaching needs the hosted site, signed in as
  the admin.)
- Notes, prep steps, tags and priority, just like a plan.

Meetings show on the calendar with their time (*2:30 PM Acme*), on Today and on the board. Cards
get a **Join** button (highlighted from an hour before the start) and a **Job description** button,
both opening in a new tab. Meetings never count as overdue: once a meeting is over it moves to
**Past meetings** on Today (after its end time) until you tick it off. **Add to my calendar** downloads a calendar file
for your phone or computer calendar, with a reminder 15 minutes before. Only web links (`https://…`)
are accepted, so a link can never run code.

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

- **Search** across titles, descriptions, tags, steps and companies. Filter by tag, priority, or
  plans versus meetings.
- **Undo** for deleting or finishing a plan, rescheduling, clearing completed plans and imports.
- **Dark mode** that follows your system, with a manual toggle.
- **Backups**: export all plans to a `.json` file and import them again from the **⋯** menu.
  Importing merges by plan, so re-importing the same backup never creates duplicates. (An older
  version of Dayplan can import these backups too, but ignores meeting details.) A backup holds the
  names of attached PDFs, not the files: those stay on your site and are copied with the
  `dayplan-data` folder. A PDF that no meeting has used for 30 days (because it was replaced, or its
  meeting was deleted) is removed then.
- **New plan** button in the top bar opens the full editor (on the calendar, for the selected day).
- Works on phones: the views move to a tab bar at the bottom, the board columns become swipeable
  panels, the calendar shows dots, and the editor opens as a bottom sheet.
- Stays in sync across open tabs, and deadline labels refresh every minute.

### Keyboard shortcuts

| Key                                  | Action                         |
| ------------------------------------ | ------------------------------ |
| <kbd>N</kbd>                         | New plan (focus quick add)     |
| <kbd>M</kbd>                         | New meeting                    |
| <kbd>/</kbd>                         | Search                         |
| <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> | Today / Board / Calendar     |
| <kbd>[</kbd> <kbd>]</kbd>            | Previous / next month          |
| <kbd>D</kbd>                         | Toggle dark mode               |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd>     | Save the open plan             |
| <kbd>Esc</kbd>                       | Close dialogs, clear search    |
| <kbd>?</kbd>                         | Show all shortcuts             |

## Where your data lives

**Opened as a file** (`index.html` on your computer, no server): there are no accounts. Plans are
stored in your browser's `localStorage`, on your device only.
Nothing is sent anywhere. Each browser keeps its own copy, so use **Export backup** to move plans
between them or to keep a safe copy. Clearing your browser's site data deletes them.

**On your site (signed in):** plans are also saved to your account on the server, in a SQLite database at
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
- Only admin accounts can save anything. Other approved accounts can only read the admin's
  meetings (a fixed list of meeting fields), never other plans or anyone else's data.
- New accounts can't sign in until the admin approves them, and at most 50 requests can wait at
  once, so strangers can't fill up the database.
- Only the admin can send meeting emails, each person gets their own copy (nobody sees who else
  got it), and the Gmail app password is kept in `dayplan-data`, never in the code or the page.

## Project layout

```
index.html          Page structure: sidebar, top bar, sign-in page, editor and dialogs
css/styles.css      All styling, light/dark themes and phone layouts
css/fonts/          The Inter font (SIL Open Font License), served with the app
js/core.js          Pure logic: plan model, quick-add parser, deadlines, sorting, stats
js/app.js           UI: rendering, drag & drop, editor, storage, sign-in and sync
dayplan_wsgi.py     Serves the app on PythonAnywhere (only index.html, css/ and js/)
dayplan_api.py      Accounts and plan sync (/api/...), stored in SQLite; also a small CLI
dayplan_mail.py     Meeting emails: writes them and sends them through Gmail
tests/              Unit tests for js/core.js and the Python files
```

`js/core.js` doesn't touch the page at all, so all the rules (date parsing, what counts as
overdue, streaks and so on) are covered by fast unit tests:

```bash
npm test               # app logic, with Node's built-in test runner (Node 18+)
npm run test:server    # the Python files, with Python's unittest (Python 3.8+)
```

No dependencies need to be installed: the server side uses only Python's standard library.
