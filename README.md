# Prince B website content management MVP

Node.js 22+, Express 5 and PostgreSQL. ES modules (`type: module`, named `export`s).
This is the website's content backend, **not** the separate Python chatbot.
The public frontend stays HTML/CSS/vanilla JavaScript on GitHub Pages.

## FAQ management

FAQs use the same staff authentication, CSRF protection, validation, audit trail
and draft/publish controls as Properties and Gallery. Both admin roles can manage
them at **`/admin/faqs`**. Search by question/category, edit the category, question
and plain-text answer, change the display order, select **Feature on the homepage**,
save a draft, publish/unpublish, or delete with confirmation. The homepage displays
at most five published featured FAQs, in API order. A featured draft stays private.

To upgrade an existing installation, from `backend-WCM/`:

```powershell
npm.cmd run migrate
npm.cmd run seed:faqs
# Restart the running Node server (Ctrl+C, then):
npm.cmd start
```

Migration **`003_faqs.sql`** adds `faqs` and `faq_seed_records`. The supplied root
`faqs.json` is copied verbatim into `src/db/seeds/faqs.json` as the approved import
snapshot. All 43 original IDs, categories, questions and answers are preserved,
including paragraphs, bullet characters and whitespace. Initial import publishes
the approved entries in source order, with `featured=false` unless supplied otherwise.
New entries default to draft and get immutable `faq-<uuid>` IDs. Editing a question
does not alter its ID or `faq.html#<id>` anchor. IDs cannot be supplied or changed
through admin request bodies.

The FAQ-only seed runs transactionally under an advisory lock and records imported
IDs independently of live entries. Reruns skip those IDs, preserving staff edits,
ordering, feature flags and publication state. **Deleted entries are not recreated**,
even when seeds run concurrently. Retain `faq_seed_records` in backups: it is import
history, not disposable cache. Keep the seed identity `client-faqs-v1` unchanged.
Use staff administration for ongoing content changes; editing the seed is not an
update mechanism. Use `seed:faqs` for FAQ upgrades so Properties/Gallery are untouched;
the existing full `seed` command also imports FAQs on fresh installations.

Public endpoint: **`GET /api/v1/faqs`**, no authentication required. It returns a
JSON array of published entries, sorted by `sort_order` then stable `id`:

```json
[{"id":"faq-01","category":"…","question":"…","answer":"…","featured":false}]
```

The public website uses its existing `js/config.js` API base. The separately hosted
Python chatbot can fetch the same endpoint server-side; its FAQ retrieval adapter
must be configured in its own project. Its `/chat` endpoint is unchanged. No deployed
WCM host is asserted here: the full production URL is your actual `PUBLIC_API_URL`
plus `/api/v1/faqs`. Locally it is `http://127.0.0.1:3000/api/v1/faqs`.

Staff API endpoints (all under `/api/v1`):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/admin/faqs` | List all FAQ drafts and published entries |
| POST | `/admin/faqs` | Create a FAQ; draft by default |
| GET | `/admin/faqs/:id` | Read an existing FAQ |
| PATCH | `/admin/faqs/:id` | Edit/reorder/feature/publish/unpublish |
| DELETE | `/admin/faqs/:id` | Delete; seeded IDs remain in import history |

FAQ answers are plain text. Use blank lines for paragraphs and `•` or `-` for
bullets; the public renderer safely creates text, paragraphs and lists, never raw HTML.
Editorial fields are validated without trimming or rewriting approved content.

## Inspection and migration decisions

- `index.html`: featured property cards; all three existing listings were featured.
- `properties.html`: active properties; `all`, `house`, `apartment`, `land` category
  buttons and case-insensitive text search. API results retain explicit order.
- `property-details.html?id=house-1` (also `apartment-1`, `land-1`): descriptions,
  asking prices, feature lists, main image/thumbnails, telephone and WhatsApp links.
  Permanent slugs preserve those URLs. New records have UUID IDs and permanent slugs.
- `gallery.html`: six image cards with title, caption, alt text, 01–06 numbering and
  a lightbox. Display order and existing image/alt references are preserved in seed JSON.
- `js/catalogue.js`: public card renderer plus the existing PrinBot widget.
  Render endpoint, context, launcher, retry behavior and demo-notice condition remain.
- No previous server, database or admin UI existed in this repository. PostgreSQL
  now stores properties, gallery, staff, sessions, media and audit logs. `src/models/validation.js`
  defines the editable fields; `src/models/content.js` owns persistence and links.

Existing fields are retained: price display text **and** numeric GHS price,
location and display location, type, availability, bedrooms, bathrooms, description,
features, images/alt text, area, plot dimensions, featured flag and display order.
Publication (`draft`/`published`) is separate from availability (`active`, `sold`,
`reserved`, `unavailable`, `unknown`). Only published records leave the public API;
the website lists active ones and displays the availability on detail pages.
Unknown facts remain null. Published prices are migrated as displayed, not verified
market valuations. Bathroom counts are unresolved in the original source.

## Local setup (PowerShell, Windows)

Install Node.js 22+ and PostgreSQL, with PostgreSQL's `bin` directory on PATH.
Run from the repository root:

```powershell
createdb -h 127.0.0.1 -U postgres prince_b_wcm
cd backend-WCM
npm.cmd ci
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Edit ignored `.env`: set `DATABASE_URL` to your database and password, paste the
generated random value into `SESSION_SECRET`, and set `ADMIN_EMAIL` and a unique
`ADMIN_PASSWORD` of 12–256 characters. Do not commit `.env` or paste secrets into
frontend files. Percent-encode special characters in database URL passwords.

```powershell
npm.cmd run migrate
npm.cmd run seed
npm.cmd run admin:create
# Remove ADMIN_PASSWORD from .env after the account is created.
npm.cmd start
```

Open **http://127.0.0.1:3000/admin/login**. In a second terminal at the repository root:

```powershell
python -m http.server 8765 --bind 127.0.0.1
```

Open **http://127.0.0.1:8765/**. The actual development frontend origin is
`http://127.0.0.1:8765`; the local API is `http://127.0.0.1:3000/api/v1`.
VS Code Live Server at `http://127.0.0.1:5500` is also allowed. Origins include the
port: `localhost` and `127.0.0.1` are different origins. Add any other frontend
origin explicitly to `CORS_ORIGINS`, and restart the API after changing `.env`.
Use the Python server only for local development; it exposes the checkout.
Production static packaging must exclude `backend-WCM`.

Migrations are tracked and transactional. Seed IDs are fixed and inserts use
`ON CONFLICT DO NOTHING`: rerunning does not duplicate content or overwrite staff
edits. Do not use seeding as a way to restore deliberately deleted items; deleted
original seed items are inserted again if you explicitly rerun the seed later.
Seed once when provisioning a fresh deployment, not on every restart.
Additional staff accounts can be created with the same command; an existing email
is never overwritten. There is no public registration or password-reset endpoint.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection URL. Use the provider's verified TLS URL/settings for external production connections; no certificate-verification bypass is configured. |
| `SESSION_SECRET` | Required random secret of at least 32 characters. Rotation signs staff out. |
| `NODE_ENV` | `development` locally, `production` on the HTTPS API host. |
| `PORT` | HTTP listener port; default 3000. Render supplies it automatically. |
| `PUBLIC_SITE_URL` | `https://jaydeladem.github.io/prince-b-realty-consult/` (trailing slash). Used for stable public property links. |
| `PUBLIC_API_URL` | Public origin of the WCM API, without a path. Local: `http://127.0.0.1:3000`; production: your actual HTTPS service origin. Required in production; used for durable uploaded image URLs. |
| `CORS_ORIGINS` | Comma-separated origins: `https://jaydeladem.github.io,http://127.0.0.1:8765,http://127.0.0.1:5500`. No repository path in origins. Cross-origin API access is read-only and never includes credentials. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Used only by `admin:create`. Remove the password afterward. |
| `TEST_DATABASE_URL` | Dedicated integration-test database with name ending `_test`; tests reset its fixture tables. Never use a production database. |

On the frontend there is **one configuration point**: `js/config.js`.
Loopback defaults to the local API; production `apiBaseUrl` is deliberately empty
until you set the actual separately hosted HTTPS URL, including `/api/v1`.
An unset URL produces a clear unavailable state, not sample listings. Public
requests omit cookies. No API host has been invented or provisioned for you.

## API

All endpoints below start with `/api/v1`. Public content arrays are returned directly
(also compatible with the separate chatbot's `LISTINGS_URL` loader).

| Method | Path | Access |
| --- | --- | --- |
| GET | `/health` | Public; 200 if DB is reachable, 503 otherwise |
| GET | `/properties` | Published properties, ordered by `sort_order`, then `id` |
| GET | `/properties/:slug` | Published property or 404 |
| GET | `/gallery` | Published gallery, ordered by `sort_order`, then `id` |
| GET | `/faqs` | Published FAQ array, ordered by `sort_order`, then stable `id` |
| GET | `/auth/session` | Current staff user (or null) and a CSRF token |
| POST | `/auth/sign-in` | JSON email/password plus `X-CSRF-Token`; rate limited |
| POST | `/auth/sign-out` | Session cookie and `X-CSRF-Token` |
| GET, POST | `/admin/properties` | Staff only; list all / create |
| GET, PATCH, DELETE | `/admin/properties/:id` | Staff only; read / edit / delete |
| GET, POST | `/admin/gallery` | Staff only; list all / create |
| GET, PATCH, DELETE | `/admin/gallery/:id` | Staff only; read / edit / delete |
| GET, POST | `/admin/faqs` | Staff only; list / create FAQs |
| GET, PATCH, DELETE | `/admin/faqs/:id` | Staff only; read / edit / delete FAQs |
| POST | `/admin/media` | Staff only; multipart file field `image`, up to 5 MB |
| GET | `/media/:id` | Image bytes; anonymous access only while referenced by published content; staff can preview private uploads |
| GET, POST | `/admin/users` | Super admin only; list / create accounts |
| GET, PATCH, DELETE | `/admin/users/:id` | Super admin only; read / edit / delete accounts |
| GET | `/admin/logs` | Super admin only; read-only paginated audit events |

Optional public property filters: `?featured=true`, `?category=house`, `?q=East%20Legon`.
The existing browser category/text filters still operate on the ordered result set.
Public endpoints return no drafts or staff/session data. Admin API errors: 400
validation, 401 unauthorized, 403 CSRF, 404 missing item, 409 duplicate slug, 503
service unavailable. PATCH merges supplied fields after locking the row. Slugs
are permanent. Media URLs must use HTTPS; missing numeric facts use JSON null.

## Staff workflow and security

Sign in at the **API host's** `/admin/login`. After signing in, `/admin` shows real
overview counts and recently updated content. `/admin/properties` provides title/
location search, publication filters and a property table; `/admin/gallery` shows
an ordered photo grid. Both share the same sidebar, API client and content editor.
Deep links such as `/admin/properties?edit=house-1` open an existing item and
`/admin/gallery?new=1` opens a new one. Session expiry returns to sign-in, preserving
a safe return path. The mobile sidebar has a menu button and keyboard controls.

New/draft items offer Save draft and Publish; published items offer Save changes
and Unpublish. Images preview from HTTPS URLs, server validation appears next to
fields, writes prevent duplicate submissions, and deletion requires confirmation.
Publishing shows a View on website link. Property editor groups match supported
fields: Property details, Pricing and features, Photos, and Description. Availability
remains separate from publication: only active properties appear in public cards.
Published edits appear after a public-page refresh without changing HTML.

Dashboard files live in the repository-root **`admin/`** folder, alongside
`backend-WCM/`: `login.html`, `login.js`, `index.html`, `admin.js`, `editor.js`,
`api.js`, `shared.js`, `admin.css`, and `assets/`. Brand assets are copies of
the existing repository logo and `images/hse2.avif`, keeping the admin deployment
available in the same checkout. Express resolves `../../admin/` from `src/app.js`
and still serves all pages and assets under `/admin`; browser URLs and same-origin
API requests do not change. Keep both sibling folders in the deployed repository.
Express also serves a public `/admin/config.js` containing
only `PUBLIC_SITE_URL`; secrets stay server-side.

### Roles, user management and system logs

Run `npm run migrate` when upgrading an existing installation. Migration 002
promotes the oldest existing staff account to **Super admin**, preserving its email
and password. Other existing accounts become **Admin**. On a fresh database,
`npm run admin:create` creates the first account as super admin; later CLI-created
accounts default to admin. Existing accounts are never overwritten by that command.

Super admins can manage content and uploads, and access **Users** (`/admin/users`)
and **System logs** (`/admin/logs`). Admins can manage Properties, Gallery and uploads,
but server middleware blocks user management and audit-log access. Sidebar visibility
reflects the role; hiding links is not the authorization mechanism. Roles and active
status are checked against the database on each protected request.

Users supports name, email, role, active status and password creation/reset. Passwords
remain hashed. Password, email, role and active-status changes revoke affected
sessions; deletion removes access immediately while retaining content and event
history. You cannot delete, disable or demote your own account, and user mutations
are serialized to preserve at least one active super admin. Only another super admin
can perform those changes to your account.

System logs record successful/failed sign-ins, sign-outs, content changes/publication,
image uploads, user management and unexpected request errors. They include event time,
actor, level and target; passwords, hashes, cookies, tokens and request bodies are
never recorded. Logs begin with this upgrade; older actions cannot be reconstructed.
The read-only endpoint supports `q`, `level=all|info|warning|error`, and `page` (50 events
per page). There is no UI/API action to edit or delete logs. Include them in backups.

Passwords use salted scrypt. Sessions persist in PostgreSQL and expire after eight
hours. Cookies are HttpOnly, SameSite=Strict and Secure in production. CSRF tokens
protect all writes and login; login regenerates the session. Helmet supplies
security headers, input schemas reject unexpected fields/unsafe media URLs, queries
use parameters, and browser renderers use text nodes for editable content.
The login rate limiter is process-local; use a shared limiter if scaling to multiple
instances. Production assumes one trusted HTTPS reverse-proxy hop (`trust proxy=1`).
Do not directly expose the Node listener to untrusted proxy headers.

## Media durability and static hosting

Existing images remain in the website's `images/` folder, referenced from the API
with absolute GitHub Pages HTTPS URLs. Both editors now accept **file uploads and
pasted URLs**. Choose JPEG, PNG, WebP or AVIF images up to 5 MB and 20 megapixels;
the server decodes the actual bytes, rejects unsupported/corrupt/animated images,
strips metadata, and converts to WebP within 2400×2400 pixels. Property images are
appended to the image list; a gallery upload sets its image URL. Save or publish the
content afterward to attach uploaded images.

Uploads are stored as PostgreSQL `bytea`, so they survive API restarts/redeploys
without a separate storage account. Include media in database backups. They do not
use ephemeral server disk. Anonymous users can read an upload only while referenced
by published content; staff can preview uploads before publishing. Unpublishing or
deleting the last published reference removes public access immediately. Uploads are
retained in storage even if an editor cancels or removes a reference; no automatic
media deletion is performed. Existing external image URLs still work.

Set `PUBLIC_API_URL` to the actual HTTPS API origin **before uploading production
images**. Keep that origin stable, or migrate stored image URLs when moving hosts.
Plain HTTP is accepted only for the API's own loopback media URLs in development.
Image alt text remains editable. This PostgreSQL approach is suitable for the MVP;
larger media libraries can later move behind the same URLs to object storage/CDN.

`_config.yml` excludes `backend-WCM` and the root `admin` folder from standard
GitHub Pages/Jekyll publishing. Staff pages are served by Express, not GitHub Pages.
If a custom workflow bypasses Jekyll, explicitly package only the frontend HTML,
`css/`, `js/`, `images/` and any intended static assets. Never upload the whole
checkout, `.env`, local DB data or `node_modules` as a public deployment artifact.

## Chatbot handoff (separate repository)

The website widget still posts to:

```
https://property-chatbot-89ed.onrender.com/chat
```

No Python/FastAPI source has been added here. The prior shared `listings.json`
remains only as a **legacy frozen snapshot** so existing consumers do not suddenly
404 during rollout. The website no longer reads it, and WCM edits do not update it.
Do not maintain it as a second content source. After deploying WCM, set this in the
**separate chatbot Render service**:

```
LISTINGS_URL=https://YOUR-WCM-SERVICE.onrender.com/api/v1/properties
DEMO_MODE=false
```

Keep its CORS origin `https://jaydeladem.github.io` and its existing backend-only
Gemini variables. If that separate deployment still reads `sample_listings.json`,
it must first deploy the previously prepared HTTPS `LISTINGS_URL` loader from its
own repository. It must exclude non-active properties and tolerate unknown fields.
The WCM property response preserves `id`, `title`, `location`, `property_type`,
`bedrooms`, `price_ghs`, `status`, `description`, `url`, and feature/image fields.
Remove the legacy snapshot only after all consumers switch to the WCM endpoint.

## Deployment order

1. Provision persistent PostgreSQL and a separate Node service using this repository,
   feature branch for review, working directory **`backend-WCM`** while retaining
   the full repository checkout (including sibling **`admin/`**). If packaging or
   containerizing the service, include both folders. Keep GitHub Pages
   pointed at the static website. No host changes are made by this implementation.
2. Set production environment variables. Build `npm ci --omit=dev`; run
   `npm run migrate`, then `npm run seed` once. Create the first admin via a private
   host shell using `npm run admin:create` and remove the password afterward.
3. Start `npm start` behind HTTPS. Check `/api/v1/health` and `/admin/`; verify a
   published property and gallery item at the public endpoints.
4. Set the actual HTTPS `apiBaseUrl` in `js/config.js`, then deploy the frontend
   through the existing GitHub Pages flow. Keep `/prince-b-realty-consult/` paths.
5. Switch the separate chatbot's `LISTINGS_URL` to the WCM properties endpoint and
   redeploy it. Verify PrinBot from the deployed website.
6. Back up PostgreSQL; keep secrets and durable media independent of service disk.

## Verification

Create an isolated test DB using your local PostgreSQL account:

```powershell
createdb -h 127.0.0.1 -U postgres prince_b_wcm_test
$env:TEST_DATABASE_URL='postgresql://postgres:YOUR_LOCAL_PASSWORD@127.0.0.1:5432/prince_b_wcm_test'
npm.cmd test
```

Tests run real Express handlers and PostgreSQL migrations/persistence, plus jsdom
DOM interaction against a live local API listener. They cover seed idempotency,
CORS, every admin content method's authentication, CSRF, both admin UI lifecycles,
private drafts, validation, stable slugs, frontend cards/featured/details/gallery,
filters, loading/error/empty states, refresh after publication, and PrinBot's
preserved request contract/demo notice. The Render reply is mocked in DOM tests;
these tests do not establish real-browser layout, CORS enforcement, mobile keyboard
behavior, live Gemini replies or deployment success.

Manual smoke check: sign in; add, edit, publish, refresh the website, unpublish,
refresh, then delete a test item in each module. Anonymous admin requests must be
401. Inspect public page refreshes at the project subpath, keyboard-operated gallery
lightbox and PrinBot's live replies. Production testing needs a real deployed WCM
URL and separate chatbot configuration/deployment access.

### Results from this implementation

The PostgreSQL/API/DOM integration suite passed locally (22 checks), including actual
admin UI create/edit/publish/unpublish/delete flows for both modules, correct overview
counts, searching/filtering, session expiry, rejected credentials, password visibility,
inline server validation, deletion cancellation and public visibility after publishing/
unpublishing, multipart uploads and public/private media visibility, server-enforced
roles, user lifecycle/session revocation, both new management screens, and log
filtering and read-only access. FAQ checks additionally cover the exact 43-record
import, source-order public contract, stable IDs, authenticated/CSRF-protected writes,
the FAQ editor and homepage/public-page integration, and full/FAQ-only/concurrent
reseeds that preserve edits, feature flags, drafts, ordering and deliberate deletion.
Both standalone local
servers returned HTTP 200 for the API health/content/admin and frontend pages.
Production dependency audit reported no known vulnerabilities. Real browser visual
verification could not run because the browser access host was unavailable.
The existing Render `/health` and greeting `POST /chat` both returned 200, with the
correct production CORS origin. That deployed chatbot still reported `demo: true`;
its real WCM retrieval and Gemini path are not yet verified. WCM itself has not
been deployed, and its production URL must be configured before publishing the frontend.
