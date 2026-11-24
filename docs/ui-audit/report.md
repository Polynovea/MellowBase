# Admin app UI audit

Status: **draft, before the first run.** Every row below comes from reading the screens' code. The
browser run (screenshots, axe, sideways scroll, broken links) has not happened yet; its findings are
added here after it, and the raw numbers land in [automated-checks.md](automated-checks.md).

- Branch: `payal/ui-tests` (from `payal/p4-final-review`).
- How to run: `npm run test:ui` (`scripts/ui-test/run.mjs`): a fresh PostgreSQL 16, a production build on
  built-in auth, the server in setup mode with the schema worker, then the Playwright stages in
  `e2e/ui` (wizard → sign-in → flows → audit → sign-out). Heavy: Docker, a database, a build and a browser.
- Screenshots: `docs/ui-audit/screenshots/<screen>-<390|1440>-<light|dark>.jpg`.

Severity: **blocks a user** (someone cannot finish a task), **confusing** (they can, but the screen
misleads them or says nothing), **polish** (looks or reads worse than it should; listed, not fixed).

## Blocks a user

| # | Screen | Issue | Screenshot | Suggested fix | Status |
|---|---|---|---|---|---|
| B1 | Calendar | Picking an event **Type** makes scheduling fail. The dropdown's options had no value, so the browser sent the label ("draft due") instead of the stored kind ("draft_due"), which the database refuses. Untouched, the box showed "draft due" but sent "review_due". | calendar-1440-light.jpg | Give each option its real value. | Fixed; `13-releases` schedules an event of a chosen type |
| B2 | Media, entry editor | Keyboard users could not upload or open an image: the upload controls (Media, and the image picker in the entry form) were hidden file inputs, and the image cards only reacted to a mouse click. | media-1440-light.jpg | Keep the file input focusable but visually hidden; make each card a real button; make the details a dialog (Escape closes, focus moves in and back). | Fixed; `11-media` uploads and opens details by keyboard |
| B3 | Developer | There is no way to create an **AI agent** or limit one to some fields. Agent identities exist in the API layer (`lib/developer/agentGovernanceService.ts`) but no screen or admin route creates them, and API tokens can be limited by model and scope, not by field. | developer-1440-light.jpg | Needs a decision: an "AI agents" section in Developer (create, limit to models and fields, bind a token), with admin routes, step-up and audit. That is a feature, not a fix. | **Open: decision for Subrojit.** `15-developer` keeps the test as `fixme` |

## Confusing

| # | Screen | Issue | Screenshot | Suggested fix | Status |
|---|---|---|---|---|---|
| C1 | Model editor | Typing a field label letter by letter set its key to the first letter only ("Subtitle" → key `s`). | model-editor-1440-light.jpg | The key follows the label until someone edits the key. | Fixed; `10-models` types the label key by key |
| C2 | Model editor | A saved field's key could be edited. A new key is treated as delete + add, so the old field's data heads for deletion. | model-editor-1440-light.jpg | Lock saved keys (read-only, with a tooltip); renaming changes the label. | Fixed; `10-models` checks the key is read-only |
| C3 | Model editor | No message after saving a change, and the "Applying your changes" line never updated until a manual reload. | model-editor-1440-light.jpg | "Saved as version N." after a save; refresh the status quietly while the worker runs; a message after a confirmed deletion. | Fixed; `10-models` waits for each |
| C4 | New model | Creating a model gave no confirmation. | model-editor-1440-light.jpg | "<name> is created." on arrival. | Fixed |
| C5 | Entry editor | The heading was "ENTRY 1A2B3C4D" (the ID), not the entry's title; creating, saving, publishing and restoring showed no message. | entry-editor-1440-light.jpg | Heading = the entry's title; "Draft created.", "Draft version N saved.", "Published.", "Version N restored as the new draft." | Fixed; `12-entries` checks each |
| C6 | Entry editor (workflow) | On a one-person install the owner cannot approve their own submission (the safe default), and the error did not say how to change that. | entry-editor-1440-light.jpg | Point to Workflows → "Allow requester self-approval" in the message. | Fixed; `12-entries` follows the link's advice |
| C7 | Model editor, new model | The field rows' label, key and type boxes had no labels: a screen reader said "edit text". | model-new-1440-light.jpg | Labels on each box; each row is a named group ("Field: Title"). | Fixed |
| C8 | Every admin screen | Every browser tab said "Polynovea Admin". | (all) | "<Screen> · Polynovea CMS"; "Sign in · Polynovea CMS"; "Preview · Polynovea CMS". | Fixed; the audit checks every screen's title |
| C9 | Setup wizard | The step list on the left looked the same on every step: it never showed where you are. | wizard-2-owner-details-1440-light.jpg | Tick done steps, mark the current one (announced to screen readers). | Fixed |
| C10 | Sign-in | The card stayed near-black in the light theme (dark text on a dark card); a "System Status: Operational" light was always on whatever the server's state; the footer's "Privacy Protocol / Terms of Access / System Status" looked like links and went nowhere. | sign-in-390-light.jpg | Theme colour for the card; remove the fake status and the fake links. | Fixed (wording below for Payal to confirm) |
| C11 | New release | Approved entries were listed as "entry:1a2b3c4d", not by title. | release-new-1440-light.jpg | Show the title, with the short ID under it. | Fixed; `13-releases` picks the entry by title |
| C12 | Release detail | Messages read "Release approve completed.", "Release schedule completed.". | release-detail-1440-light.jpg | "Release approved.", "Release scheduled.", "Release cancelled.", "Release published: every pinned version is live." | Fixed |
| C13 | Developer | Revoking a token took one click with no confirmation; the copy-secret button had no name; the quick start always said `localhost:3000`. | developer-1440-light.jpg | Confirm dialog for revoke; "Copy the secret"; use this server's own address. | Fixed; `15-developer` checks the address and the button |
| C14 | Localization | With no locales the page showed an empty area; the locale-code box had no label. | localization-1440-light.jpg | An empty state that says what to do; a label and hint on the box. | Fixed; `14-translate` checks the empty state |
| C15 | Media details | "Where Used Impact Graph (1 references)"; the details panel was not a dialog. | media-details-1440-light.jpg | "Used in 1 entry" / "Not used yet"; dialog semantics (see B2). | Fixed; `12-entries` checks "Used in 1 entry" |
| C17 | Setup wizard | When the database is already configured (server settings, or a wizard resumed after its database step), the setup code still led to "Choose the database", offering choices that no longer apply. | wizard-2-owner-details-1440-light.jpg | Go straight to the owner step; if the database page is opened anyway, say the database is ready and link on. | Fixed; unit test in app/api/setup/code/route.test.ts, and `01-wizard` expects the owner step next |
| C16 | Entry editor (workflow), release detail, records list | Unlabelled boxes: the reviewer note, the release decision note and assignment fields, the records search, filters and row checkboxes. | entries-1440-light.jpg | Labels on each. | Fixed |

### Sign-in wording changed (C10) — Payal to confirm

| Before | After |
|---|---|
| "Executive Command" under the logo | "Content management" |
| "Authorized personnel only. Access monitored by Global Security Protocols." | "Only people invited to this workspace can sign in." |
| "© 2026 Polynovea Executive Command. All Rights Reserved." + three dead "links" | "Polynovea CMS" |
| "System Status: Operational" (always on) | removed; the System page shows the real health |

## Polish (listed, not fixed)

| # | Screen | Issue | Suggested fix |
|---|---|---|---|
| P1 | Records / entries | One thing, four names: the menu says "Data Studio", the page "Records", the button "New record", the editor "Content library". | Pick one ("Entries" matches the API and the docs) and use it everywhere. |
| P2 | Several | Some headings are in capitals ("CREATE MODEL", "CHOOSE A MODEL", "NEW UI TEST ARTICLE", "CREATE RELEASE"), others in sentence case. | Sentence case throughout, as on the newer screens. |
| P3 | Records list | Rows show the entry's short ID and search text, not its title. | Show the title as the row's name. |
| P4 | Media | A refused file says "Unsupported file type: application/x-msdownload". | "Only images (JPEG, PNG, WebP, GIF), MP4 or WebM video and PDF can be uploaded." |
| P5 | Confirm dialogs | The busy label always says "Deleting…", also when revoking a token. | Let each dialog set its busy label. |
| P6 | Model editor | The Visual / Advanced / Migration / API switcher is plain buttons, not tabs. | Tab semantics (role="tablist", arrow keys). |
| P7 | Calendar | A failed load's error stays on screen after a later load works. | Clear the error when a load succeeds. |
