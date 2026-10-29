# Manual integration test — Phase 3 + Phase 4

Not run automatically. Requires a live database and a running
server, and is meant to be driven by you against a **test account**,
not the production BA account — create a disposable `app_users` row
for this (see step 0) so these runs never touch real credentials or
real Case data from automated tooling.

## 0. Create a disposable test BA account (once)

```
npm run hash-password
```

Enter a throwaway password, copy the hash, then insert a test row
directly (adjust the SQL in Supabase Studio — do not reuse the real
BA's row):

```sql
INSERT INTO public.app_users (user_id, email, password_hash, rt_role, display_name)
VALUES (gen_random_uuid(), 'test-ba@example.invalid', '<hash from above>', 'BA', 'Test BA');
```

This account has no auth.users row and no FK dependents, so it's
freely disposable — `DELETE FROM app_users WHERE email = 'test-ba@example.invalid'`
when done (cascades to its sessions via `ON DELETE CASCADE`).

## 1. Start the server

```
npm run dev
```

## 2. Auth flow

```bash
# Login — save the Set-Cookie value for subsequent requests
curl -i -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test-ba@example.invalid","password":"<the throwaway password>"}'

# Wrong password — expect 401 UNAUTHENTICATED
curl -i -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test-ba@example.invalid","password":"wrong"}'

# Me, with the cookie from login — expect 200 with the test user's info
curl -i http://localhost:3000/api/cases \
  --cookie "rt_session=<value from Set-Cookie>"

# Me, with no cookie — expect 401 UNAUTHENTICATED
curl -i http://localhost:3000/api/auth/me

# Logout, then retry an authenticated route — expect the old cookie to now be rejected
curl -i -X POST http://localhost:3000/api/auth/logout --cookie "rt_session=<value>"
curl -i http://localhost:3000/api/auth/me --cookie "rt_session=<value>"
```

## 3. Case API — success paths

```bash
COOKIE="rt_session=<value from a fresh login>"

# Create
curl -i -X POST http://localhost:3000/api/cases \
  -H "Content-Type: application/json" --cookie "$COOKIE" \
  -d '{"case_code":"TEST-001","case_name":"Test case","incoming_request":{"request_code":"REQ-TEST-001","request_text":"test","source_type":"EMAIL"}}'
# Expect 201, body includes case/incomingRequest/association

# List
curl -i http://localhost:3000/api/cases --cookie "$COOKIE"

# Get (use the case_id from Create's response)
curl -i http://localhost:3000/api/cases/<case_id> --cookie "$COOKIE"
# Expect incomingRequests to include REQ-TEST-001

# Update
curl -i -X PATCH http://localhost:3000/api/cases/<case_id> \
  -H "Content-Type: application/json" --cookie "$COOKIE" \
  -d '{"case_name":"Renamed test case"}'
# Expect 200, case_name changed, status/primary_owner_user_id unchanged
```

## 4. Error / edge-case paths

```bash
# Missing auth — expect 401 for every Case route
curl -i http://localhost:3000/api/cases

# Duplicate case_code — expect 409 CONFLICT, and verify in Studio that
# NO extra incoming_requests/case_request_associations row was created
# for this attempt (confirms transaction rollback, not a partial write)
curl -i -X POST http://localhost:3000/api/cases \
  -H "Content-Type: application/json" --cookie "$COOKIE" \
  -d '{"case_code":"TEST-001","case_name":"Duplicate","incoming_request":{"request_code":"REQ-TEST-002","request_text":"x","source_type":"EMAIL"}}'

# Missing case_name — expect 400 VALIDATION_ERROR
curl -i -X POST http://localhost:3000/api/cases \
  -H "Content-Type: application/json" --cookie "$COOKIE" \
  -d '{"case_code":"TEST-002","incoming_request":{"request_code":"REQ-TEST-003","request_text":"x","source_type":"EMAIL"}}'

# Update a case_id that doesn't exist — expect 404 NOT_FOUND
curl -i -X PATCH http://localhost:3000/api/cases/00000000-0000-0000-0000-000000000000 \
  -H "Content-Type: application/json" --cookie "$COOKIE" \
  -d '{"case_name":"x"}'

# Wrong role — flip the test account's rt_role check by using a
# non-BA session if one exists, or inspect authorize.ts's unit tests
# (test/authorize.test.ts) for this path instead, since the schema's
# only allowed rt_role today is 'BA' (see chk_app_users_role).
```

## 5. Cleanup

```sql
DELETE FROM public.cases WHERE case_code LIKE 'TEST-%';
-- cascades are RESTRICT, not CASCADE, on case_request_associations/
-- incoming_requests per the original schema, so delete child rows
-- first if the above fails:
DELETE FROM public.case_request_associations WHERE case_id IN (
  SELECT case_id FROM public.cases WHERE case_code LIKE 'TEST-%'
);
DELETE FROM public.incoming_requests WHERE request_code LIKE 'REQ-TEST-%';
DELETE FROM public.audit_events WHERE case_id NOT IN (SELECT case_id FROM public.cases);
DELETE FROM public.app_users WHERE email = 'test-ba@example.invalid';
```
