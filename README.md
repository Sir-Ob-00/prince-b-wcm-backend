# Prince B WCM API

Separate Node.js 22+ / Express / PostgreSQL service for Prince B Realty Consult.
The static public site and staff UI belong to JayDeladem/prince-b-realty-consult;
this repository serves only the API. It does not serve an admin HTML folder.

## Deployment and cross-site staff sessions

Deploy this service before the website frontend update. Render settings:

- Build: `npm ci`; start: `npm start`.
- `NODE_ENV=production`
- `DATABASE_URL`: existing Aiven connection string; keep it secret.
- `SESSION_SECRET`: existing random secret of at least 32 characters.
- `PUBLIC_API_URL=https://prince-b-wcm-backend.onrender.com` (origin only).
- `PUBLIC_SITE_URL=https://jaydeladem.github.io/prince-b-realty-consult/`
- `CORS_ORIGINS=https://jaydeladem.github.io,http://127.0.0.1:8765,http://127.0.0.1:5500`
- `PORT` is supplied by Render.

The exact CORS origin has no project path. Credentialed GET/POST/PATCH/DELETE
requests allow Content-Type and X-CSRF-Token. Production cookies are HttpOnly,
Secure, SameSite=None and Partitioned, with an eight-hour expiry. Express trusts
one reverse proxy for HTTPS detection. The session remains in PostgreSQL; all
admin writes still require authentication, role authorization and a session-bound
CSRF token. Sign-out clears the same cookie attributes. No bearer token is stored
in browser localStorage. Never use wildcard origins with credentials.

The staff UI is https://jaydeladem.github.io/prince-b-realty-consult/admin/index.html.
Browsers that support partitioned cookies can retain this cross-site session;
browsers that block it may need an explicit site exception. The frontend verifies
cookie continuity and reports blocked sessions. Do not weaken CSRF or authentication
to bypass browser policy. A same-site custom domain/reverse proxy is the durable
alternative for browsers that disallow all cross-site cookies.

This change needs no new migration or seed on the existing Aiven database.
Do not reseed or recreate the existing staff account just to deploy it.

## Local setup

```powershell
npm.cmd ci
Copy-Item .env.example .env
# Edit DATABASE_URL and SESSION_SECRET. Use a local PostgreSQL database for development.
# Set PUBLIC_API_URL=http://127.0.0.1:3000 locally, NODE_ENV=development.
npm.cmd run migrate
npm.cmd run seed
npm.cmd start
```

Migrations are in src/db/migrations; approved seed snapshots are in src/db/seeds.
`npm run seed:faqs` imports the 43 original FAQs without overwriting staff edits
or recreating deliberately deleted FAQs; retain faq_seed_records in backups.
Use the admin UI for ongoing content changes. Public endpoints expose published
records only, in display order. Slugs and FAQ IDs remain stable after editing.
Media uploads are validated and stored in PostgreSQL, surviving redeploys.

For a new installation only, set ADMIN_EMAIL and ADMIN_PASSWORD in a private shell,
run `npm run admin:create`, then remove ADMIN_PASSWORD. Passwords are hashed.
Existing super admins manage accounts and view audit logs through the staff UI.

## Endpoints

All routes use /api/v1:

- GET /health
- GET /properties, /properties/:slug, /gallery, /faqs
- GET /auth/session (session and CSRF token), POST /auth/sign-in, /auth/sign-out
- GET/POST /admin/properties, /admin/gallery, /admin/faqs
- GET/PATCH/DELETE /admin/properties/:id, /admin/gallery/:id, /admin/faqs/:id
- Authenticated POST /admin/media; public GET /media/:id for published media
- Super-admin account management under /admin/users and read-only /admin/logs

The separate Python chatbot can consume
https://prince-b-wcm-backend.onrender.com/api/v1/properties and /api/v1/faqs.
Its configuration and deployment remain in its own repository.

## Verification

```powershell
# Dedicated disposable PostgreSQL DB only; its name must end in _test.
$env:TEST_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:5432/prince_b_wcm_test'
npm.cmd test
```

Backend tests run real migrations, persistence, auth/CSRF, publication lifecycles,
roles, media visibility, FAQ import history and production cookie/CORS contracts.
They never use DATABASE_URL for fixture resets. Static frontend DOM tests live
in the website repository and no longer require this backend folder alongside it.
HTTP tests cannot prove browser cookie acceptance. After deployment, sign in from
the GitHub Pages UI, refresh, publish and edit a test item, verify public refresh,
unpublish/delete it, and sign out in the browsers staff actually use.
