# Admin app UI audit

Status: **done** (24 Nov 2026). Every flow in the brief passes end to end except the AI-agent flow,
which has no screen yet (B3: an Agents screen, to be built right after PR #90 as its own small PR). All "blocks a user" and "confusing" items found are fixed,
except B3. Polish items are listed, not fixed.

- App fixes in PR #90: `payal/ui-product-fixes` up to ffae780, merged by the coordinator; the branch is frozen. Later fixes (A11) go on `payal/ui-fixes-2` (from sroy/phase-4) for a follow-up PR.
- Tests, tooling, screenshots and this report: branch `payal/ui-tests`, which merges the app fixes,
  so the suite runs on the same app code.
- How to run: `npm run test:ui` (`scripts/ui-test/run.mjs`). It sets up a fresh PostgreSQL 16, builds
  the app for production on built-in auth, and starts the server in setup mode with the schema worker.
  Then it runs the Playwright stages in `e2e/ui`: wizard → sign-in → flows → audit → sign-out. Heavy:
  Docker, a database, a build and a browser, about 6 minutes.
- Results of the last run: [automated-checks.md](automated-checks.md) (generated). It lists counts per
  flow, axe results per screen and view, and every axe rule that fired.
- Screenshots: `docs/ui-audit/screenshots/<screen>-<390|1440>-<light|dark>.jpg`, every main screen in
  four views.

Severity: **blocks a user** (someone cannot finish a task), **confusing** (they can, but the screen
misleads them or says nothing), **polish** (looks or reads worse than it should; listed, not fixed).
Rows B1–B3 and C1–C17 come from reading the code. The rest come from the browser runs.

## Results of the last run

Run 10, 24 Nov 2026 18:09–18:15 UTC, on payal/ui-tests bfbc54f (the app code of payal/ui-product-fixes plus A11). **All stages passed.**

| Flow (spec) | Passed | Failed | Not yet possible |
|---|---|---|---|
| Setup wizard by keyboard, with a passkey (01-wizard) | 2 | 0 | 0 |
| Two-step sign-in and seed:starter (02-signin) | 2 | 0 | 0 |
| Data models: create, add, rename, delete, typed-key confirm, restore (10-models) | 3 | 0 | 0 |
| Media: upload and where used (11-media) | 3 | 0 | 0 |
| Entries: create, edit, preview, submit, approve, publish (12-entries) | 4 | 0 | 0 |
| Releases and calendar (13-releases) | 3 | 0 | 0 |
| Translation (14-translate) | 2 | 0 | 0 |
| API token, and AI agent (15-developer) | 2 | 0 | 1 (B3) |
| System: health, backups, upgrade screen (16-system) | 1 | 0 | 0 |
| Screen audit, links and the accessibility gate (80-audit) | 29 | 0 | 0 |
| Sign-out (90-signout) | 1 | 0 | 0 |
| **Total** | **52** | **0** | **1** |

Every flow with a form also checks a wrong input and its success message, and every list checks its empty state. System and sign-out have no form: System checks that the health checks, the backups and the no-upgrade-agent message show, and that no Upgrade button is offered.

- **Accessibility (axe, WCAG 2.2 A/AA and best practice), 53 screens × 4 views = 212 views:** 0
  critical, 0 serious. Not gated: 92 moderate and 4 minor element findings (P12).
- **Screenshots:** 212 files in `docs/ui-audit/screenshots/`, 53 screens at 390 px and 1440 px, light
  and dark (about 12 MB, JPEG).
- **Layout:** no screen scrolls sideways at 390 px. Every screen has its own tab title. No broken
  same-site link.
- **Keyboard:** the whole wizard, sign-in, the entry editor, the media upload and image details run by
  keyboard, with a visible focus ring checked at each step.

Path to here: 10 locked runs. The first three found test bugs; runs 4–9 found the app issues below.

## Blocks a user

| # | Screen | Issue | Screenshot | Fix | Status |
|---|---|---|---|---|---|
| B1 | Calendar | Picking an event **Type** made scheduling fail. The options had no value, so the browser sent the label ("draft due") instead of the stored kind ("draft_due"). | calendar-1440-light.jpg | Each option has its real value. | **Fixed** (3df8e3a); `13-releases` schedules an event of a chosen type |
| B2 | Media, entry editor | Keyboard users could not upload or open an image. The upload controls were hidden file inputs, and the image cards reacted only to a mouse click. | media-1440-light.jpg | The file inputs stay focusable but are hidden from view. Cards are buttons. The details are a dialog: Escape closes it, and focus moves in and back. | **Fixed** (10da0f4); `11-media` uploads and opens details by keyboard |
| B3 | Developer | There is no way to create an **AI agent** or limit one to some fields. Agent identities exist only in the API layer (`lib/developer/agentGovernanceService.ts`). Migration 0078 lets an API token act as a role, and roles carry field permissions, but the Developer screen has no role picker for tokens and no agent section. | developer-1440-light.jpg | An "AI agents" section in Developer (create, limit to models and fields, bind a token), with admin routes, step-up and audit, plus a role picker on token creation. That is a feature, not a fix. | **Open: decided.** The coordinator will have it built right after PR #90 as its own small PR (an Agents screen). `15-developer` keeps the test as `fixme` until then |
| B4 | Every admin screen | **Busy pages signed people out.** The browser re-checked the session before nearly every API call. The server allows 100 checks a minute per network address. Any error in that check signed the person out for good. | infrastructure-1440-light.jpg | Reuse a successful check for 10 seconds, cleared on sign-in, sign-out and step-up. On a failed check, retry after 1, 3 and 8 s, then say what happened; never sign out. | **Fixed** (2deac04); the audit and sign-out stages cover it. Server limit: follow-up F1 |
| B5 | Site Tree & Routes, entry editor, release detail | **Nothing could be published or released on a fresh install.** Both need the entry's canonical route, but Register Route had no way to choose the entry, although the server accepts one. | release-detail-1440-light.jpg | An **Entry** picker in Register Route. Each "no canonical route" finding links to the form with the entry chosen. | **Fixed** (0559285); `12-entries` and `13-releases` follow the link, add the route, then publish and release |
| B6 | Site Tree & Routes, Taxonomy, Redirects, Navigation | **The owner was refused ("Missing required permission").** Migration 0024 added these screens' permissions but granted them to no role. | release-detail-1440-light.jpg | **Migration 0079** grants the eight permissions to owner and admin, as 0007 intended. It adds role_permissions rows only and is idempotent. | **Fixed** (f962609); approved by the coordinator; full test:dual 424/424 |
| B7 | Model editor | **A field's label, help text, default or order could not be changed.** The review lists only data-relevant changes, so a rename came back "No schema changes detected". | model-editor-1440-light.jpg | Save any schema that differs from the current version (compared normalised). The review says when only presentation changed. | **Fixed** (63aead7); unit test, and `10-models` renames a label |
| B8 | Calendar | **Six of the seven event types always failed** with "Invalid event (ref …)". Only a "campaign" may stand alone, and the form had no way to say what an event is about. | calendar-1440-light.jpg | An **About** picker for releases and entries, required unless the type is campaign. A plain message from the service. | **Fixed** (38e9fdb); assertions added to the dual test "schedules calendar events…" in `lib/content/releaseService.dual.test.ts`, and `13-releases` schedules a publish slot |

## Confusing

| # | Screen | Issue | Screenshot | Fix | Status |
|---|---|---|---|---|---|
| C1 | Model editor | Typing a field label letter by letter set its key to the first letter only ("Subtitle" → `s`). | model-editor-1440-light.jpg | The key follows the label until someone edits the key. | **Fixed** (63aead7) |
| C2 | Model editor | A saved field's key could be edited, which means delete + add: the old data heads for deletion. | model-editor-1440-light.jpg | Saved keys are read-only, with a tooltip. | **Fixed** (63aead7) |
| C3 | Model editor | No message after saving. The "Applying your changes" line never updated without a reload. | model-editor-1440-light.jpg | "Saved as version N." The status refreshes while the worker runs. A message after a confirmed deletion. | **Fixed** (63aead7) |
| C4 | New model | Creating a model gave no confirmation. | model-editor-1440-light.jpg | "<name> is created." | **Fixed** (63aead7) |
| C5 | Entry editor | The heading was the entry's ID. Create, save, publish and restore showed no message. | entry-editor-1440-light.jpg | The heading is the entry's title, with a message for each action. | **Fixed** (5eddc92) |
| C6 | Entry editor | On a one-person install the owner cannot approve their own submission, and the error did not say how to change that. | entry-editor-1440-light.jpg | The error points to Workflows → "Allow requester self-approval". | **Fixed** (5eddc92) |
| C7 | Model editor, new model | The field rows' boxes had no labels. | model-new-1440-light.jpg | Labels on each; rows are named groups. | **Fixed** (63aead7) |
| C8 | Every admin screen | Every browser tab said "Polynovea Admin". | (all) | "<Screen> · Polynovea CMS". | **Fixed** (8935a51); the audit checks every title |
| C9 | Setup wizard | The step list never showed the current step. | wizard-2-owner-details-1440-light.jpg | Done steps are ticked; the current step is marked. | **Fixed** (383f4b2) |
| C10 | Sign-in | The card stayed near-black in the light theme. A "System Status: Operational" light was always on. Three footer "links" went nowhere. | sign-in-390-light.jpg | The card follows the theme; the fake status and links are gone. | **Fixed** (8935a51); wording below for Payal to confirm |
| C11 | New release | Entries were listed by ID. | release-new-1440-light.jpg | Listed by title. | **Fixed** (e4b0ae9) |
| C12 | Release detail | "Release approve completed." | release-detail-1440-light.jpg | "Release approved." and similar. | **Fixed** (0559285) |
| C13 | Developer | Revoke happened with one click. The copy button had no name. The quick start said `localhost:3000`. | developer-1440-light.jpg | Revoke asks first. The copy button is named. The quick start shows this server's address. | **Fixed** (e4b0ae9) |
| C14 | Localization | No empty state; the code box had no label. | localization-1440-light.jpg | An empty state and a labelled box. | **Fixed** (e4b0ae9) |
| C15 | Media details | "Where Used Impact Graph (1 references)". | media-details-1440-light.jpg | "Used in 1 entry". | **Fixed** (10da0f4) |
| C16 | Entry editor, release detail, records list | Unlabelled boxes. | entries-1440-light.jpg | Labels. | **Fixed** (several) |
| C17 | Setup wizard | With the database already configured, the setup code still led to "Choose the database". | wizard-2-owner-details-1440-light.jpg | Go straight to the owner step; the database page says it is ready. | **Fixed** (383f4b2); unit test |
| C18 | Model editor | Typing a new field's label lost focus after one letter. | model-editor-1440-light.jpg | Rows keyed by position. | **Fixed** (63aead7) |
| C19 | Site Tree & Routes | The route form's errors appeared behind the dialog. | release-detail-1440-light.jpg | Errors show in the dialog. | **Fixed** (0559285) |

### Sign-in wording changed (C10): Payal to confirm

| Before | After |
|---|---|
| "Executive Command" under the logo | "Content management" |
| "Authorized personnel only. Access monitored by Global Security Protocols." | "Only people invited to this workspace can sign in." |
| "© 2026 Polynovea Executive Command. All Rights Reserved." + three dead "links" | "Polynovea CMS" |
| "System Status: Operational" (always on) | removed; the System page shows the real health |

## Found by axe and the layout checks

| # | Screen | Issue | Screenshot | Fix | Status |
|---|---|---|---|---|---|
| A1 | Every admin screen (light) | Muted text was 4.49:1 on the menu, under 4.5:1. | command-center-1440-light.jpg | #716876 → #675E6C (4.7–5.5:1). | **Fixed** (e5fb8d4) |
| A2 | Command Center | Timestamps used the disabled colour (2.4:1 light, 3.2:1 dark). | command-center-1440-dark.jpg | The muted colour. | **Fixed** (e5fb8d4) |
| A3 | Blog, Metrics, Delivery Ops, Redirects, Developer | Scrolling tables and code blocks could not be reached by keyboard. | delivery-ops-390-light.jpg | They take focus and have a name. | **Fixed** (e5fb8d4, e4b0ae9) |
| A4 | Content Intelligence, Delivery Ops, Operational Intelligence, Routes, Import | Unnamed dropdowns, buttons and links. | content-intelligence-1440-light.jpg | Names. | **Fixed** (e5fb8d4) |
| A5 | Developer | Scrolled sideways at 390 px. | developer-390-light.jpg | The columns may shrink. | **Fixed** (e4b0ae9) |
| A6 | Model editor | The tab title fell back to "Polynovea Admin". | model-editor-1440-light.jpg | The title is put back when changed. | **Fixed** (8935a51) |
| A7 | Entry editor | Image and rich-text fields sat in one label; the first image button took the field's name. | entry-new-1440-light.jpg | Named groups; rich-text boxes are named. | **Fixed** (5eddc92) |
| A8 | Access | The members table could not be reached by keyboard. | access-390-light.jpg | It takes focus. | **Fixed** (e5fb8d4) |
| A9 | Assurance | Route rows' dropdowns had no names. | assurance-1440-light.jpg | Named with the route's path. | **Fixed** (fcd2ac4) |
| A10 | Entry editor, preview, release detail, workflows, visual studio | Unnamed Collaboration and Impact controls. Faint grey on the preview. A faint cyan Schedule button. An unnamed remove-stage button. No tab title while the studio loads. | entry-editor-1440-light.jpg | Names, contrast, title. | **Fixed** (ffae780) |
| A11 | Preview | The active viewport label was near-white on beige (1.34:1). | entry-preview-1440-light.jpg | Colour set inside the link (see P11). | **Fixed, landing after PR #90:** on `payal/ui-fixes-2` (5576fbe, on sroy/phase-4) for the follow-up PR; also on `payal/ui-tests` |

## Follow-ups (not this lane's to change)

| # | For | Item | Detail |
|---|---|---|---|
| F1 | Auth owner, with the peer-address change | **Session-check rate limit.** Per the coordinator it goes with the peer-address change. `/api/auth/get-session` falls under Better Auth's default limit of 100 requests a minute per address (`lib/auth/betterAuth/server.ts`, `rateLimit` with `window: 60, max: 100`; the custom rules cover only sign-in, two-factor, passkey and change-password). | B4's client fix brings one page down to a few checks. An office of about 20 people behind one address, each with a few tabs open, can still reach 100 a minute. If it does, sign-in checks fail and the screens show "We couldn't check your sign-in just now" (no sign-out any more). Suggested change: a custom rule for `/get-session` of about 600 a minute. The route only reads the caller's own session and is not a credential check. It is a server-side auth decision. |
| F2 | Next PR after #90 | **Agents screen (B3).** | Per the coordinator: built right after #90 as its own small PR. See B3. |
| F3 | Payal | **Sign-in wording (C10).** | Confirm or change the new wording above. |

## Polish (listed, not fixed)

| # | Screen | Issue | Suggested fix |
|---|---|---|---|
| P1 | Records / entries | One thing, four names: "Data Studio" (menu), "Records" (page), "New record" (button), "Content library" (editor). | Pick one ("Entries" matches the API and docs). |
| P2 | Several | Some headings are in capitals ("CREATE MODEL", "NEW UI TEST ARTICLE"), others in sentence case. | Sentence case throughout. |
| P3 | Records list | Rows show the short ID and search text, not the title. | Show the title. |
| P4 | Media | A refused file says "Unsupported file type: application/x-msdownload". | "Only images (JPEG, PNG, WebP, GIF), MP4 or WebM video and PDF can be uploaded." |
| P5 | Confirm dialogs | The busy label always says "Deleting…". | Let each dialog set it. |
| P6 | Model editor | The Visual / Advanced / Migration / API switcher is plain buttons. | Tab semantics. |
| P7 | Calendar | A failed load's error stays after a later load works. | Clear it on success. |
| P8 | Site Tree & Routes | The locale dropdown is a fixed list (en, fr, es, de). | Use the workspace's locales. |
| P9 | Release detail | Pinned versions show "entry:cc860647". | Show the title. |
| P10 | Setup wizard | At 390 px the SSH command in the address note runs to the box's edge. | Let it wrap. |
| P11 | Every screen | `app/globals.css` sets `a { color: inherit; }` outside any CSS layer, so it beats every text-colour class put on a link (Tailwind's utilities are layered). Links silently ignore their colour classes; A11 was one result. | Move the rule into `@layer base`. Then check the screens, since some links will change colour. |
| P12 | Several | Moderate axe findings, not gated: duplicate or nested `main` landmarks (Infrastructure, Operational Intelligence, Release detail, Workflows: the page adds its own `main` inside the layout's), landmarks without unique names, content outside landmarks on sign-in, no `h1` on the preview, a skipped heading level in Experience Studio, an empty table header on Developer. | Use `div` or `section` inside the layout's `main`; name repeated landmarks; add an `h1` to the preview. |
