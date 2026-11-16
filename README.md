# Returnable Delivery Challan cum Gate Pass

A working implementation of the Technical Specification: Node/Express backend, PostgreSQL
database, and a plain HTML/JS frontend (no build step required). Built and tested end-to-end
against a real local Postgres instance — see "What's been tested" below.

## Stack
- **Backend**: Node.js + Express
- **Database**: PostgreSQL 14+ (via Docker Compose for local dev)
- **PDF generation**: `pdfkit` (pure JS, no headless-browser dependency)
- **Frontend**: React + Vite, with the existing vanilla-JS screens retained under `frontend/legacy/` during the compatibility migration

## Project layout
```
challan-app/
├── docker-compose.yml       # Postgres 16, auto-runs schema.sql + seed.sql on first boot
├── db/
│   ├── schema.sql           # Full DDL (Section 8 of the spec)
│   └── seed.sql             # One seed user per role
├── backend/
│   ├── package.json
│   ├── .env.example         # Copy to .env and adjust
│   └── src/
│       ├── server.js        # Entry point
│       ├── app.js           # Express app wiring
│       ├── config.js
│       ├── db.js            # Postgres pool
│       ├── middleware/      # authenticate (JWT), authorize (RBAC), errorHandler
│       ├── utils/           # AppError, asyncHandler, validators (Section 9 Master Validation Table)
│       ├── services/        # numbering (Section 5), audit, pdf, fileStorage (signed URLs)
│       ├── state/           # transitions.js — exact Section 4.1 state machine
│       └── routes/          # auth, challans (all Section 7.2 endpoints), files
└── frontend/
    ├── index.html            # Redirects to login or dashboard
    ├── login.html             # Screen 1
    ├── dashboard.html + js    # Screen 2 — Challan List
    ├── challan-form.html + js # Screen 3 — Create / Edit
    ├── challan-detail.html + js # Screens 4, 5, 6 — Detail view, Return modal, Reject/Cancel modal
    ├── css/style.css
    └── js/api.js              # Shared fetch client + auth helpers
```

## Running it locally

### 1. Start Postgres
```bash
cd challan-app
docker compose up -d
```
This creates the `challan_db` database, runs `db/schema.sql`, then `db/seed.sql` automatically
(only on first boot — delete the `pgdata` volume to re-seed from scratch).

If you don't have Docker, install Postgres locally and run the two SQL files manually instead:
```bash
psql -U youruser -d yourdb -f db/schema.sql
psql -U youruser -d yourdb -f db/seed.sql
```

### 2. Start the backend
```bash
cd backend
cp .env.example .env       # adjust DATABASE_URL / JWT_SECRET if needed
npm install
npm start                  # listens on http://localhost:4000
```

### 3. Start the React frontend
```bash
cd frontend
npm install
npm run dev
# then open http://localhost:8080
```
The React entry point owns routing and loads the preserved workflow templates from
`frontend/legacy/`, so the existing API calls, validation, approval actions, PDF downloads,
OTP flow, and admin console behavior remain unchanged. For production, deploy the Vite build
behind a static host configured to rewrite application routes to `index.html`:
```bash
npm run build
```

## Production readiness gate

Do not deploy the development folder directly. Before production:

1. Rotate every credential that has ever been stored in `backend/.env`, including SMTP, Twilio, database and JWT secrets. The current file is local development configuration and must not be copied to a server or committed.
2. Create the PostgreSQL roles and permissions using `db/migrations/018_production_database_roles.sql` with a separate bootstrap account. The backend must connect only as `challan_app`.
3. Run all database migrations with `rgp_db_admin`, take and verify a backup, and set `RUN_SCHEMA_GUARD=false` in production. Startup must not perform schema changes.
4. Set `NODE_ENV=production`, a 32+ character random `JWT_SECRET`, the company HTTPS URL in `APP_BASE_URL`, and an explicit comma-separated `ALLOWED_ORIGINS` value.
5. Keep PostgreSQL on a private network, require TLS, and allow port 5432 only from the backend host and approved database administration network.
6. Serve the frontend and API behind the company HTTPS reverse proxy; do not expose the Node process or PostgreSQL directly to the internet.
7. Do not run `db/seed.sql` in production. Create users with unique temporary passwords, force first-login password changes, and enable MFA/OTP for the application administrator.
8. Exclude `backend/.env`, `node_modules`, logs, local PDFs, uploads and company documents from the deployment package. Store secrets in the company-approved secret manager.
9. Configure process supervision, log rotation, monitoring, backup retention and a tested restore procedure.
10. Run an acceptance test in a staging environment before production: login, password change/OTP, user roles, challan workflow, PDF generation, file access, email delivery and audit-log immutability.

### 4. Log in
Seed accounts (all use password `Password123!`). The seeded `full_name` is just the role
name itself, so no personal names appear anywhere in the demo data:

| Role | Email | Name |
|---|---|---|
| Admin | admin@stemz.local | Admin |
| Preparer | preparer@stemz.local | Preparer |
| Authorizer | authorizer@stemz.local | Authorizer |
| Security | security@stemz.local | Security |
| Viewer | viewer@stemz.local | Viewer |

**Change these before using this outside local development** — they're plaintext-obvious
placeholder credentials seeded for demo purposes only.

## Branding
The app uses Stemz's logo (`frontend/assets/logo.png`, also embedded in generated PDFs via
`backend/assets/logo.png`) and a light-green theme matching it (see `:root` in
`frontend/css/style.css` to adjust the palette). Generated PDF copies are labeled exactly:
**ORIGINAL – CONSIGNEE**, **DUPLICATE – TRANSPORTER (SECURITY)**, **TRIPLICATE – CONSIGNOR**.

## Change password, location scoping & address-based state auto-fill

Additions on top of the original MVP:

**1. Change password** — reachable two ways: the "Change password" link in the topbar
(already logged in), and a "Change password" link directly on `login.html` (no session needed
yet — an email field appears in that case). Both post to the same
`PATCH /api/v1/auth/change-password`. When reached from the login page, the form first calls
`/auth/login` with the email + current password to verify it and obtain a token (this call
bypasses the shared `api()` helper's auto-redirect-on-401, so a wrong current password shows an
error message instead of silently bouncing the page), then uses that token for the actual
change. Either way, the frontend logs the user out immediately after a successful change so
they re-authenticate with the new password right away (JWTs already issued can't be revoked
server-side here, so this is the safe default).

The login page no longer displays the seed account list or working credentials in the
placeholder text — the demo credentials still exist in `db/seed.sql` (all 5 seed accounts use
password `Password123!`), they're just no longer shown on-screen. Store them somewhere private
if you need them for local testing.

**2. Preparer/Security/Viewer scoped to their location** — `users.location` (nullable) is
matched against `delivery_challans.qmc_location`. A PREPARER, SECURITY, or VIEWER user with a
location assigned can only see, and only act on, challans at that location:
- A PREPARER's created/edited challans always get `qmc_location` forced to their own location,
  server-side, regardless of what's submitted.
- List, single-challan read, the audit trail, and every write action (edit, add/remove item,
  submit, gate-out, return) all enforce this; a cross-location attempt returns `403 FORBIDDEN`.
- VIEWER's scoping is read-only, same as before — it just now also excludes other locations'
  challans, not only statuses (SECURITY's existing "issued+ only" status restriction is
  unchanged and still layers on top for that role).
- ADMIN and AUTHORIZER are never location-restricted — they oversee all locations. A
  PREPARER/SECURITY/VIEWER with no `location` set (NULL) is also unrestricted — set it
  explicitly to scope a user.
- **If your database already existed before this change**, `seed.sql` won't re-run on its own
  (see the Docker note above) — apply `db/migrations/001_add_user_location.sql` and then set
  `location` on your users, e.g.:
  ```sql
  UPDATE users SET location = 'QMC Store, Building 1' WHERE email = 'preparer@stemz.local';
  UPDATE users SET location = 'QMC Store, Building 1' WHERE email = 'security@stemz.local';
  UPDATE users SET location = 'QMC Store, Building 1' WHERE email = 'viewer@stemz.local';
  ```

**3. State auto-generated from address, State Code field removed from the form** —
`backend/src/utils/indianStates.js` (mirrored in `frontend/js/indian-states.js` for a live
preview as you type) scans a free-text address and fills `consignee_state` from it as you leave
the address field, in two tiers:
  1. A state/UT name or alias appears literally in the address (e.g. "...Haryana - 122003") →
     use that directly, it's the most authoritative signal.
  2. Otherwise, a **district, or well-known city/former name, that maps to exactly one state** →
     covers the much more common case where an address names a place, not the state itself
     (e.g. "SIDCO Industrial Estate, Coimbatore" → Tamil Nadu, with no "Tamil Nadu" anywhere in
     the text). `DISTRICT_TO_STATE` covers ~830 entries — the official district list for every
     state/UT, plus common former names (Bombay, Madras, Calcutta, Trivandrum, Bangalore) and
     split metro sub-regions (Bengaluru Urban/Rural, Mumbai City/Suburban). Regexes for all ~860
     candidates (states + districts) are precompiled once at module load, not per-call — a
     lookup costs about 4 microseconds.

  The **State Code input was removed from the create/edit form entirely** — it's no longer
  something a preparer types. The backend still resolves and stores it:
  - If the address matches (state or district) and State was left blank → both State and its
    code are filled from that match.
  - Otherwise, if a State name is present (typed directly, or loaded from an existing record)
    but no code → the code is resolved by an exact name/alias match (`getStateCodeByName`).
  - An explicitly-sent state (and/or code) in the same request is never overridden.

  The detail view and the generated PDF still correctly show "State & State Code" together —
  that's a real GST requirement and wasn't touched; only the *manual input* for the code is
  gone from data entry.

  **Coverage caveat** (stated plainly, not glossed over): Indian district boundaries change
  periodically — Telangana went from 10 to 33 districts in 2016, Andhra Pradesh split out 13 new
  districts in 2022. This list reflects a recent, reasonably complete official set per state; it
  is not guaranteed to include the very newest district splits. A missing district just means no
  state gets auto-filled (never a wrong guess) — the State field is always still editable by
  hand. If you find a gap, add it to the relevant `addDistricts('<State>', [...])` call in
  `indianStates.js` (and its frontend mirror) — it's plain data, no logic changes needed.

  **Two real bugs found and fixed in this logic along the way:**
  - *Wrong state detected.* Matching used plain substring search, so short state aliases like
    `UP`/`MP`/`TN`/`HP` matched **inside ordinary words** — "XYZ **Complex**" contains "mp" and
    was wrongly tagged Madhya Pradesh; "**Group** Housing Society" contains "up" and was wrongly
    tagged Uttar Pradesh. Both are extremely common in real Indian addresses. Fixed by switching
    to word-boundary (`\bMP\b`) matching, so an alias only counts when it appears as its own
    word/token — confirmed the false positives are gone while genuine cases (`"Noida, UP"`,
    `"MP Nagar, Bhopal"`) still detect correctly.
  - *State never auto-filled on edit.* The edit route checked `consignee_state === undefined`
    to decide "was a state provided in this request", but this frontend form always re-sends
    every field on every save — an empty State field arrives as explicit `null`, never as an
    omitted key. That check was therefore effectively always false on edit, so the address→state
    fill only ever worked on the very first save. Fixed by using the same falsy check
    (`!body.consignee_state`) the create route already used correctly.

## What's been tested

This isn't just scaffolding — I stood up a real Postgres instance, ran the backend against it,
and scripted a 21-point end-to-end test covering the full lifecycle:
login (all 5 roles + bad password), draft creation, server-side RBAC denials, submit,
approve-and-issue (with real 3-copy PDF generation), SECURITY's restricted read-scope,
gate-out, partial return, full return, post-issue remarks-only editing, optimistic-concurrency
conflicts (409), the audit trail, and filtered listing. All 21 checks pass.

I also rendered a generated PDF to an image to visually confirm the 3-copy layout, the Rule 55
statement, and correct date formatting.

The three additions above (change password, location scoping, address→state auto-fill) were
verified the same way, against the same live Postgres + Express instance: wrong/short/correct
password changes and the resulting login behavior; a Preparer's `qmc_location` being forced to
their assigned location on create even when a different value was submitted; a Preparer's list
and direct-access endpoints correctly excluding another location's challan (`403`); Security's
list and `gate-out` showing the identical scoping; and address text for both Haryana and
Chandigarh correctly auto-filling state + GST state code.

A follow-up round extended and re-verified the same way: VIEWER's list and single-challan `GET`
correctly excluding another location's challan (including a still-`DRAFT` one at their own
location, which VIEWER *can* see unlike SECURITY); VIEWER's audit-trail endpoint scoped
identically, while AUTHORIZER's remained unrestricted; and — since the State Code field was
removed from the form — a state typed directly with no matching address (e.g. "Tamil Nadu")
still correctly resolved its GST code (`33`) via the new name-based fallback, confirmed all the
way through submit → approve-and-issue → the generated PDF.

A third round specifically targeted the address→state detection after real-world testing turned
up problems: a scripted check of 23 realistic district/city-only addresses (no state name
present in any of them, e.g. `"Whitefield, Bengaluru"`, `"Boring Road, Patna"`,
`"MG Road, Coimbatore"`) — 23/23 resolved to the correct state; the two previously-reproduced
false positives (`"XYZ Complex..."` → wrongly Madhya Pradesh, `"...Group Housing..."` → wrongly
Uttar Pradesh) now correctly return no false match; the pre-login change-password flow (verify
current password via `/auth/login`, then change) was exercised end-to-end including a wrong-password
rejection; and a full create → submit → approve-and-issue run confirmed a district-only address
("Coimbatore") correctly produces `Tamil Nadu / 33` all the way through to the issued challan.

## Known gaps / what to do before real production use
This is an MVP scaffold meant to get you running fast, not a finished, hardened product. Before
using it for real business data:

- **Secrets**: `.env` ships with placeholder `JWT_SECRET` and seed passwords — rotate both.
- **PDF storage**: currently writes to local disk (`backend/storage/pdfs/`). Swap for real S3-compatible
  object storage per the spec's recommended architecture (the `services/pdf.js` and `services/fileStorage.js`
  modules are the two places to change).
- **HTTPS**: the spec requires all traffic over HTTPS (Section 10) — this local setup runs plain HTTP;
  put a reverse proxy (nginx/Caddy) with TLS in front for anything beyond localhost.
- **DB privilege lockdown**: `db/schema.sql` includes commented-out `REVOKE`/`GRANT` statements for
  `audit_events` — run those once you've created your actual application DB role, so the app can never
  UPDATE/DELETE audit rows even if application code has a bug.
- **Frontend polish**: functional but intentionally plain (no framework, no build step) so it's easy to
  read and modify. Section 6.7's loading/empty/403/409 states are implemented but minimal.
- **Session revocation**: there's no token blocklist — a password change or role/location edit doesn't
  invalidate a session's existing JWT before it naturally expires (`JWT_EXPIRES_IN`).
- **No automated test suite checked in**: the 21-point test script that validated this build lived outside
  the repo. Worth turning into a proper Jest/Supertest suite before this goes further.
- Nothing from Section 12 ("Explicitly Out of Scope") has been built, by design — GSTIN verification,
  e-way bill integration, automated tax calc, digital signatures, etc. all remain fast-follow items.

---

## RGP Workflow Update (two-level approval)

Implements `RGP_Workflow_Analysis_and_Implementation_Plan.docx`.

**Flow:** Preparer submits → **Center Manager (CM)** approves → **GSOC** (the `AUTHORIZER` role) approves & issues → Security gate-out → CM records return → closed. Overdue material triggers a daily reminder email to the CM.

| Action | From → To | Roles |
| --- | --- | --- |
| `POST /challans/:id/submit` | DRAFT → SUBMITTED (Pending CM) | PREPARER, ADMIN |
| `POST /challans/:id/cm-approve` | SUBMITTED → CM_APPROVED (Pending GSOC) | CENTER_MANAGER (same location), ADMIN |
| `POST /challans/:id/cm-reject` | SUBMITTED → REJECTED (**Changes Requested**, rework up to 3 cycles) | CENTER_MANAGER, ADMIN |
| `POST /challans/:id/send-back` | CM_APPROVED → SUBMITTED (reason saved to `gsoc_remarks`) | AUTHORIZER, ADMIN |
| `POST /challans/:id/approve-and-issue` | CM_APPROVED → ISSUED | AUTHORIZER, ADMIN |
| `POST /challans/:id/clone` | any → new DRAFT (optional fresh request) | PREPARER, ADMIN |
| `POST /challans/:id/return` | as before, **CENTER_MANAGER added** | + CENTER_MANAGER |

Rejected records remain editable as Changes Requested records. The applicant must update at least one field before resubmitting; each resubmission increments the visible submission version. Immutable snapshots are available through `GET /challans/:id/versions`.
`GET /challans?pending_action=true` returns the "pending my action" queue for the logged-in role.

### Upgrading an existing database
Run in this order (PostgreSQL cannot use a new enum value in the same transaction that adds it). Both are safe to re-run:
```
docker exec -i challan_postgres psql -U challan_app -d challan_db < db/migrations/006a_rgp_enums.sql
docker exec -i challan_postgres psql -U challan_app -d challan_db < db/migrations/006b_rgp_columns.sql
```
Existing challans in `SUBMITTED` are now treated as *Pending CM Approval*. See the commented `UPDATE` at the bottom of `006b` if you'd rather move them straight to GSOC. Fresh installs get everything from `schema.sql` / `seed.sql` (adds `cm@stemz.local`, password `Password123!`).
Then: `cd backend && npm install` (adds `nodemailer`, `node-cron`).

### Email & reminders (`.env`)
Set `SMTP_*`, `MAIL_FROM`, `APP_BASE_URL`. With `SMTP_HOST` empty, emails are only logged to the console. Optional: `GSOC_EMAILS`, `LOCAL_SM_EMAILS`, `REMINDER_CRON` (default 09:00 daily), `REMINDER_INTERVAL_DAYS`, `ESCALATE_TO_GSOC_AFTER_DAYS`. Emails are sent after the action commits and never block or roll it back. Create one `CENTER_MANAGER` user per center with the matching `location`.

### Other fixes
`seed.sql` no longer inserts a `challan_sequences` row without `location_code` (it failed on a fresh database; sequences are created on demand).

---

## Update: approval-screen polish (this round)

1. **Number colour + GSOC label** - already in place from the previous round (challan number in blue, "GSOC" shown next to the version badge on both the dashboard and the detail page).
2. **Buttons locked until resubmission** - already in place: once GSOC sends a request back, the CM's Approve/Reject buttons are replaced with a disabled pair and a note, both server- (`CHANGES_REQUESTED_PENDING`) and client-enforced, until the applicant edits and resubmits.
3. **No blank resubmission** - already in place both ways: the form compares a fingerprint of the payload and blocks the Submit button client-side, and the server independently blocks it (`CHANGES_REQUESTED_NO_UPDATE`) by checking for a `FIELD_UPDATED` audit event after the last change request.
4. **Tax Details no longer mandatory** - new this round. Total Taxable Value, Tax Rate, CGST, SGST/UTGST and IGST are optional even when "Is Taxable Supply" is checked, on the form and in the API validator. Whatever *is* filled in is still checked (valid number, valid rate, and - if enough of the section is filled in to compute one - that the GST split is correct).
5. **Field- vs section-level errors** - a field error still shows right under that field. A few errors are about a whole section rather than one input (e.g. "at least 1 item is required"); those now show in a highlighted banner at the top of that section (see `.section-error` in `style.css`) instead of being attached to a single field. Whole-form errors (e.g. "nothing changed since the last request") show in the page's top error banner.
6. **Auto-scroll to the error** - already in place for field errors; now also added to the top error banner and the new section-error banners, so every kind of error brings itself into view.
7. **"Changes Requested" instead of "Rejected"** - the display labels were already in place from the previous round, but the underlying database enum value had been renamed from `REJECTED` to `CHANGES_REQUESTED` (see `schema.sql`) without every place in the app being updated to match, which made CM/GSOC "request changes" throw a server error. This round finishes that rename consistently across the backend (`transitions.js`, `routes/challans.js`) and frontend (`challan-form.js`, `challan-detail.js`, `api.js`, `dashboard.html`, `style.css`).
8. **Audit terminology** - the audit trail's fallback label list was extended so every event type (created, submitted, CM/GSOC actions, gate-out, return, cancel, field edits, clone, reminders) has a short, readable label using the same CM / GSOC abbreviations as the rest of the app, instead of showing the raw internal event code for anything not explicitly listed.
9. **Version per Changes-Requested cycle** - already in place from the previous round: `submission_version` starts at 1 and increments by 1 each time the applicant resubmits after a CM rejection or a GSOC send-back (not on every edit). Shown next to the challan number as "Version N".

### A note on item 4
The request said *"Tax Details: css is not mandatory."* The most literal reading is that the **Tax Details** section (Taxable Value / Tax Rate / CGST / SGST / IGST) should not be mandatory, which is what was implemented. If "css" was meant as something else, let me know what fields it should refer to and I can adjust.

## Update: v4 changes

1. **Tax Details are mandatory** when "This is a taxable supply" is ticked - Total Taxable Value and Tax Rate are required (CGST/SGST/IGST are calculated from them). Only **Cess** is optional. Enforced in the form and in `validators.js`.
2. **Tax-rate dropdown bug fixed** - PostgreSQL returns the saved rate as `5.00`, which the validator compared as text against `5 / 12 / 18` and rejected ("Must be one of: 5, 12, 18") even though 5% was selected. The rate is now compared numerically (validator) and normalised when an existing challan is loaded into the form.
3. **Cancel -> Reject** - "Cancel Request" is now "Reject Request" (button, modal title, "Rejection Reason" card, audit label "REQUEST REJECTED", status label "REJECTED", server messages). API path (`/cancel`) and the stored status value (`CANCELLED`) are unchanged, so no DB migration is needed.
4. **Audit trail wording** - "CM" is spelled out as "Center Manager" (e.g. "APPROVED BY CENTER MANAGER").
5. **Submit locked until the applicant edits** - on a Changes-Requested application, the *Submit for Approval* button is disabled until at least one field (including goods lines) is modified; it also stays enabled if edits were already saved since the request. The server-side check (`CHANGES_REQUESTED_NO_UPDATE`) remains.
6. **Dashboard** - the "Pending my action" and "Overdue only" checkboxes are removed. All challans are listed for every role by default; narrow them with the Status / Movement / Transport / Consignee / date filters. (The `pending_action` / `overdue` query params still exist in the API but the UI no longer sends them.)

## Update: v5 - version numbering (V1 / V2 / V3)

- **What a version is:** the number of times the applicant has submitted the challan. A draft has no version. First submission = **V1 (Original Submission)**, first resubmission = **V2 (Resubmission 1)**, second resubmission = **V3 (Resubmission 2 - Final)**.
- **Only 3 versions are allowed.** After V3 the applicant cannot edit or resubmit (API error `MAX_VERSIONS_REACHED`); they must use *Create New Request*. Enforced in `routes/challans.js` (`submit` and `PATCH`) and in the form/detail pages.
- **Dashboard** has a new *Version* column (V1 / V2 / V3 chip with its name); the GSOC tag under the challan number also shows the code, e.g. `GSOC . V2`.
- **Detail page** shows the version in Approval Progress, and the change-request cards say which version was reviewed and how many resubmissions are left. The audit trail's "SUBMITTED TO CENTER MANAGER" entry records the version, e.g. "V2 . Resubmission 1".
- The version now goes up when the applicant **submits**, not when a reviewer requests changes (previously it counted change requests).
- **Existing database:** run `db/migrations/013_submission_version_counts_submissions.sql` once to convert existing rows to the new meaning.
  `docker exec -i challan_postgres psql -U challan_app -d challan_db < db/migrations/013_submission_version_counts_submissions.sql`
- Limitation to be aware of: if GSOC sends a request back while it is already at V3, the request is closed to further resubmission; the Center Manager/GSOC can Reject it and the applicant can raise a new request.


### Fix: new challan showing V2 after first submit
- Existing database: run `db/migrations/014_fix_submission_version_default.sql` once (sets the column default to 0 and re-normalises rows).
  `docker exec -i challan_postgres psql -U challan_app -d challan_db < db/migrations/014_fix_submission_version_default.sql`
- New/cloned drafts are now inserted with `submission_version = 0` explicitly, and the first submit of a DRAFT always records V1.


## Fix: error when entering a reason for "Request Changes" (CM/GSOC) or "Reject Request"
- **Cause:** older databases still had the status value `REJECTED` (the app writes `CHANGES_REQUESTED`) and an old unique rule on `challan_versions`, so saving the reason failed.
- **Fix:** the backend now repairs the database automatically on every start (`services/schemaGuard.js`). The same steps are in `db/migrations/015_fix_changes_requested_and_versions.sql` if you prefer to run it by hand:
  `docker exec -i challan_postgres psql -U challan_app -d challan_db < db/migrations/015_fix_changes_requested_and_versions.sql`
- Reasons are trimmed and validated on both the form and the server (friendly "Please enter a reason" message, max 2000 characters); the Confirm button locks while sending so a double-click cannot trigger a second, failing request.
- Database problems now return a clear `DB_OUT_OF_DATE` message instead of "An unexpected error occurred".

---

## Admin Console (v8) - privileged roles

The application has one administrative role:

| Role | Responsibility |
|---|---|
| **ADMIN** | Manages application users, configuration and signatures. |

The application `ADMIN` cannot modify or delete `audit_events` or `admin_audit_log`. These tables are protected by database permissions and append-only triggers. Use separate database roles for migrations; the runtime `challan_app` account should not own production schema objects.

Production credentials must not be stored in seed files, source control or chat. Create each privileged account with a unique email, generate a temporary password, set `must_change_password = TRUE`, deliver the temporary password through an approved secure channel, and require a password change plus MFA/OTP at first login. The migration intentionally creates no production credentials.

The application `ADMIN` role is separate from PostgreSQL roles. For a company-server deployment, run `db/migrations/018_production_database_roles.sql` as a PostgreSQL bootstrap administrator. It creates:

| PostgreSQL role | Use |
|---|---|
| `rgp_schema_owner` | `NOLOGIN` owner role for application schema objects. Never put this in the backend connection string. |
| `rgp_db_admin` | Named database migration/operator login. Assign its password out-of-band and use it only for administration. |
| `challan_app` | Backend runtime login with table access and no audit-log update/delete privileges. |

The migration contains no passwords. After applying it, set passwords securely with PostgreSQL's `\password` command or your company's secret-management process. On an existing database where `challan_app` owns tables, the database administrator must transfer object ownership to `rgp_schema_owner`; PostgreSQL object owners can bypass ordinary `REVOKE` permissions.

ADMIN is now the system's highest-privilege **management** role. Sign in as an admin and you land on `admin.html`.

| Area | What the admin can do |
|---|---|
| **Users & Credentials** | Create Applicants (PREPARER), Center Managers, GSOC/Authorizers, Security and Viewers; assign location and designation; generate or set a password (shown once; the user must change it at first login); reset passwords; activate/deactivate; edit details. |
| **Digital signatures** | Attach a PNG/JPG **or a drawn signature** when adding a user, and change or remove it at any time. Images are checked (real PNG/JPG, < 1 MB) and stored in `users.signature_data`. |
| **Approval blocks** | The Prepared / Checked / Authorized block on the PDF prints each signer's signature image, name and date. Admin can rename the blocks and toggle signature/name/date. Prepared = applicant, Checked = Center Manager who approved, Authorized = GSOC who issued. |
| **Form fields** | Rename any built-in field; make non-mandatory ones required/hidden; add custom fields (text, long text, number, date, dropdown, checkbox). Custom fields show on the form, the detail page and the PDF, and are stored in `delivery_challans.custom_data`. |
| **Activity log** | Every admin action is recorded in `admin_audit_log`. |

Design decisions
* Admin no longer submits, approves, issues, gates out or returns challans - those actions belong to the named people whose signatures appear on the document. Admin can still view every challan and PDF (all locations).
* GST-mandatory fields (GSTINs, addresses, movement type, dates, ...) are **locked**: label only. Everything else is configurable.
* A signature change applies to documents generated afterwards. Issued PDFs are not re-signed until they are regenerated (e.g. on gate-out / return).
* Safeguards: an administrator cannot deactivate or change their own role, and the last active administrator cannot be removed.
* Database changes are in `db/migrations/016_admin_console.sql` and `db/migrations/017_production_privileged_roles.sql`; the startup schema guard applies the audit protections for existing databases.
* The seeded admin password (`Password123!`) is for local development only and must never be used in production.

API: `GET/POST /api/v1/admin/users`, `PATCH /admin/users/:id`, `POST /admin/users/:id/reset-password`, `GET/PUT/DELETE /admin/users/:id/signature`, `GET/POST /admin/fields`, `PATCH/DELETE /admin/fields/:key`, `POST /admin/fields/reorder`, `GET/PUT /admin/approvals`, `GET /admin/overview`, `GET /admin/activity`; read-only form definition for all users at `GET /api/v1/config/form`.
