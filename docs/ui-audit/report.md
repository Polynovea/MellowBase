# Admin app UI audit

Status: **in progress.** Rows B1–B3 and C1–C17 come from reading the screens' code; rows B4 and A1–A6
come from the browser runs (screenshots, axe, sideways scroll, broken links). The raw numbers of the
last run are in [automated-checks.md](automated-checks.md).

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
| B3 | Developer | There is no way to create an **AI agent** or limit one to some fields. Agent identities exist in the API layer (`lib/developer/agentGovernanceService.ts`) but no screen or admin route creates them, and API tokens can be limited by model and scope, not by field. | developer-1440-light.jpg | Needs a decision: an "AI agents" section in Developer (create, limit to models and fields, bind a token), with admin routes, step-up and audit. That is a feature, not a fix. | **Open: decision for Subrojit.** `15-developer` keeps the test as `fixme`. Part of it exists already: migration 0078 lets an API token act as a role, and roles carry field permissions (content_field_permissions); the Developer screen has no role picker for tokens and no agent section. |

| B4 | Every admin screen | **Busy pages signed people out.** The browser re-checked the session before nearly every API call; the server allows 100 session checks a minute per network address; and any error in that check signed the person out for good. The run lost its session on Setup & Infrastructure, and every later screen showed the sign-in page. A team behind one office connection shares that limit. | infrastructure-1440-light.jpg | Reuse a session check for 10 seconds (cleared on any sign-in, sign-out or step-up); on a failed check, retry (1, 3, 8 s) and then say what happened, never sign out. Server limit left as is (see note below). | Fixed in `lib/auth/builtinClient.ts`, `lib/admin/useAdminAccess.ts`; the audit and sign-out runs cover it |

| B5 | Site Tree & Routes, entry editor, release detail | **Nothing could be published or released on a fresh install.** Publishing and releases require the entry's own address (an active canonical route; the Assurance policy turns this on by default), but the Register Route form had no way to choose the entry, although the server accepts one. The readiness panels said "Assign an active canonical route" with no way to do it. | release-detail-1440-light.jpg | An **Entry** picker in Register Route (required for "Routable Entry"); each "no canonical route" finding links to the form with the entry already chosen. | Fixed; `12-entries` and `13-releases` follow the link, add the route and then publish and release |

| B6 | Site Tree & Routes, Taxonomy, Redirects, Navigation | **The owner was refused ("Missing required permission")** on these four screens' changes. Migration 0024 added their permissions but granted them to no role; 0007 had given the owner every permission that existed before it. With B5, this meant nothing on a fresh install could be published. | (route form showing the refusal) | Migration 0079 grants the eight permissions to owner and admin, as 0007 intended. Idempotent. | Fixed; `13-releases` and `12-entries` register routes as the owner |
| B7 | Model editor | **A field's label, help text, default or order could not be changed.** The change review lists only changes that matter to stored data, so a rename came back "No schema changes detected" and Apply stayed disabled. | model-editor-1440-light.jpg | Save any schema that differs from the current version (compared normalised); the review says "Only names, help text, defaults or order changed… the database does not change". The data-risk review itself is unchanged. | Fixed; unit test in lib/schema/modelService.test.ts, and `10-models` renames a label |

| B8 | Calendar | **Six of the seven event types always failed** with "Invalid event (ref …)". The table allows an event with no entry or release only for "campaign", and the form had no way to choose one. | calendar-1440-light.jpg | An **About** picker (releases and entries by name), required unless the type is campaign; the service says so in plain words before the database refuses. | Fixed; dual test in lib/content/releaseService.dual.test.ts, and `13-releases` schedules a publish slot about the release |

Note on B4 for the coordinator: `/api/auth/get-session` falls under Better Auth's default 100 requests a
minute per address (`lib/auth/betterAuth/server.ts`). With the client fix one page makes a handful of
checks, but an office of 20 behind one address could still reach it. Raising that one route's limit
(say 600 a minute; it only reads the caller's own session) is a server-side auth decision, so it is left
to the auth owner.

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
| C18 | Model editor | Typing a new field's label lost focus after one letter: each row was keyed by its field key, which follows the label, so every keystroke rebuilt the row. | model-editor-1440-light.jpg | Key the rows by position. | Fixed; `10-models` types the label key by key |
| C19 | Site Tree & Routes | The route form's errors appeared on the page behind the dialog, where they could not be read; the dialog just stayed open. | (route form) | Show them inside the dialog. | Fixed |
| C16 | Entry editor (workflow), release detail, records list | Unlabelled boxes: the reviewer note, the release decision note and assignment fields, the records search, filters and row checkboxes. | entries-1440-light.jpg | Labels on each. | Fixed |

### Sign-in wording changed (C10) — Payal to confirm

| Before | After |
|---|---|
| "Executive Command" under the logo | "Content management" |
| "Authorized personnel only. Access monitored by Global Security Protocols." | "Only people invited to this workspace can sign in." |
| "© 2026 Polynovea Executive Command. All Rights Reserved." + three dead "links" | "Polynovea CMS" |
| "System Status: Operational" (always on) | removed; the System page shows the real health |

## Found by the browser runs (axe, layout)

| # | Screen | Issue | Screenshot | Fix | Status |
|---|---|---|---|---|---|
| A1 | Every admin screen (light theme) | Muted text, used for the whole side menu, was 4.49:1 on the menu background, under the 4.5:1 minimum (axe "serious"). | command-center-1440-light.jpg | Muted text colour #716876 → #675E6C: 4.7–5.5:1 on every light surface. | Fixed (`app/globals.css`) |
| A2 | Command Center (both themes) | Timestamps and small lines used the "disabled" colour: 2.4:1 light, 3.2:1 dark. | command-center-1440-dark.jpg | Muted colour, as for other secondary text. | Fixed |
| A3 | Blog, Metrics, Delivery Ops, Redirects, Developer | Tables and code blocks that scroll sideways could not be reached by keyboard (axe "serious"). | delivery-ops-390-light.jpg | They take focus (Tab), with a name for screen readers. | Fixed |
| A4 | Content Intelligence, Delivery Ops, Operational Intelligence, Site Tree & Routes, Import | Unnamed dropdowns, an icon-only "save search" button and an icon-only back link (axe "critical"/"serious"). | content-intelligence-1440-light.jpg | Names on each. | Fixed |
| A5 | Developer | At 390 px the page scrolled sideways: the long curl line and the OpenAPI text widened the columns. | developer-390-light.jpg | The columns may shrink; the code blocks scroll inside themselves. | Fixed |
| A7 | Entry editor | Image and rich-text fields were wrapped in one label, so the first image button was named after the field ("Hero image media") instead of the image, and later controls had no name. | entry-new-1440-light.jpg | Named groups instead of labels; each rich-text box has its own name. | Fixed; `12-entries` picks the image by its name |
| A8 | Access | The members table scrolls sideways at 390 px but could not be reached by keyboard. | access-390-light.jpg | It takes focus, with a name. | Fixed |
| A9 | Assurance | Once a route exists, each route row has indexing and sitemap dropdowns without names (axe critical). | assurance-1440-light.jpg | Names that include the route's path. | Fixed |
| A6 | Model editor | The tab title fell back to "Polynovea Admin" after "Create model" (Next.js re-applies the layout's title on some navigations). | model-editor-1440-light.jpg | The screen's title is put back whenever it is changed. | Fixed |

Moderate and minor axe findings (not gated, listed in [automated-checks.md](automated-checks.md)): content
outside landmarks ("region"), duplicate or nested `main` landmarks on a few screens, a skipped heading
level, an empty table header. They become polish rows below once the last run confirms them.

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
| P8 | Site Tree & Routes | The locale dropdown is a fixed list (en, fr, es, de), not the workspace's locales. | List the locales from Localization. |
| P9 | Release detail | Pinned versions show "entry:cc860647", not the entry's title. | Show the title, with the short ID under it (as the new-release picker now does). |
| P10 | Setup wizard | At 390 px the SSH command in the address note runs to the box's edge. | Let it wrap, or scroll inside its own box. |
